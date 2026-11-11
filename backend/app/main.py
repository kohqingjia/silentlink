import hashlib
import json
import logging
import os
import tempfile
import time
import uuid
import zipfile
from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from uuid import UUID
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from starlette.background import BackgroundTask
from .config import settings
from .db import APIKey, Recording, Session, SessionLocal, engine
from .schemas import RecordingIn, SessionIn
from .signals import csv_bytes, summarize

logging.basicConfig(level=logging.INFO, format='%(message)s')
log = logging.getLogger('silentlink')


@asynccontextmanager
async def lifespan(app):
    settings.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    yield


api = FastAPI(title='SilentLink Research API', version='0.1.0', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
buckets = OrderedDict()


def limited(key, limit):
    now = time.monotonic()
    bucket = buckets.setdefault(key, deque())
    buckets.move_to_end(key)
    while bucket and bucket[0] <= now - 60:
        bucket.popleft()
    if len(buckets) > 10000:
        buckets.popitem(last=False)
    if len(bucket) >= limit:
        raise HTTPException(429, 'Rate limit exceeded', headers={'Retry-After': '60'})
    bucket.append(now)


def auth(request: Request, authorization: Annotated[str | None, Header()] = None):
    if not authorization or not authorization.startswith('Bearer ') or len(authorization) > 256:
        raise HTTPException(401, 'A device API key is required', headers={'WWW-Authenticate': 'Bearer'})
    digest = hashlib.sha256(authorization[7:].encode()).hexdigest()
    with SessionLocal() as db:
        key = db.get(APIKey, digest)
        if key is None:
            raise HTTPException(401, 'Invalid or revoked device key', headers={'WWW-Authenticate': 'Bearer'})
        limited(key.owner, settings.rate_limit_per_minute)
        return key.owner


Owner = Annotated[str, Depends(auth)]


@api.middleware('http')
async def audit(request, call_next):
    start = time.monotonic()
    request_id = str(uuid.uuid4())
    try:
        limited('ip:' + (request.client.host if request.client else 'unknown'), 600)
    except HTTPException as exc:
        return JSONResponse({'detail': exc.detail}, status_code=exc.status_code, headers=exc.headers)
    response = await call_next(request)
    response.headers['X-Request-ID'] = request_id
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    # Do not log query strings, authorization headers or sensor payloads.
    log.info(json.dumps({'request_id': request_id, 'method': request.method, 'status': response.status_code, 'elapsed_ms': round((time.monotonic() - start) * 1000)}))
    return response


@api.exception_handler(Exception)
async def unexpected_error(request, exc):
    log.error(json.dumps({'event': 'request_failed', 'error_type': type(exc).__name__}))
    return JSONResponse({'detail': 'Internal server error'}, status_code=500)


@api.get('/health')
def health():
    try:
        with engine.connect() as db:
            db.execute(text('SELECT 1'))
        return {'status': 'ok', 'version': '0.1.0', 'inference_enabled': False}
    except Exception:
        return JSONResponse({'status': 'unhealthy'}, status_code=503)


@api.get('/api/v1/me')
def me(owner: Owner):
    return {'owner': owner, 'inference_enabled': False, 'audio_enabled': False}


def session_dict(s):
    from datetime import timezone
    result = {k: getattr(s, k) for k in ('id', 'experiment', 'device', 'started_at', 'notes', 'protocol_version')}
    if result['started_at'].tzinfo is None:
        result['started_at'] = result['started_at'].replace(tzinfo=timezone.utc)
    return result


def recording_dict(r):
    return {**{k: getattr(r, k) for k in ('id', 'session_id', 'label', 'recording_type', 'started_at', 'sample_count', 'created_at')}, 'statistics': json.loads(r.stats_json)}


@api.post('/api/v1/sessions', status_code=201)
def create_session(body: SessionIn, owner: Owner):
    values = body.model_dump()
    values['id'] = str(body.id)
    with SessionLocal() as db:
        existing = db.get(Session, values['id'])
        if existing:
            if existing.owner != owner:
                raise HTTPException(409, 'Session ID already exists')
            # Stable client-generated IDs make retries safe without overwriting data.
            previous = session_dict(existing)
            if previous['started_at'].tzinfo is None:  # SQLite tests only
                from datetime import timezone
                previous['started_at'] = previous['started_at'].replace(tzinfo=timezone.utc)
            if previous != values:
                raise HTTPException(409, 'Session ID exists with different metadata')
            return previous
        row = Session(owner=owner, **values)
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, 'Session creation raced; retry request')
        return session_dict(row)


@api.get('/api/v1/sessions')
def sessions(owner: Owner, limit: int = Query(500, ge=1, le=1000), offset: int = Query(0, ge=0)):
    with SessionLocal() as db:
        return [session_dict(s) for s in db.scalars(select(Session).where(Session.owner == owner).order_by(Session.started_at.desc()).limit(limit).offset(offset))]


@api.get('/api/v1/sessions/{session_id}')
def session_detail(session_id: UUID, owner: Owner):
    with SessionLocal() as db:
        row = db.get(Session, str(session_id))
        if not row or row.owner != owner:
            raise HTTPException(404, 'Session not found')
        return session_dict(row)


@api.post('/api/v1/recordings', status_code=201)
def upload(body: RecordingIn, owner: Owner):
    payload = body.model_dump(mode='json')
    canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    digest = hashlib.sha256(canonical).hexdigest()
    rid = str(body.id)
    with SessionLocal() as db:
        session = db.get(Session, str(body.session_id))
        if not session or session.owner != owner:
            raise HTTPException(404, 'Session not found')
        if body.device != session.device:
            raise HTTPException(422, 'Recording device differs from session device')
        old = db.get(Recording, rid)
        if old:
            if old.owner == owner and old.digest == digest:
                return recording_dict(old)
            raise HTTPException(409, 'Recording ID exists with different content')
        # Content-addressed files prevent conflicting retries from overwriting data.
        filename = f'{rid}-{digest}.json'
        path = settings.data_dir / filename
        with tempfile.NamedTemporaryFile(dir=settings.data_dir, delete=False) as tmp:
            tmp.write(canonical)
            temp_path = Path(tmp.name)
        os.replace(temp_path, path)
        row = Recording(id=rid, owner=owner, session_id=str(body.session_id), label=body.label,
                        recording_type=body.recording_type, started_at=body.started_at,
                        sample_count=len(body.samples), digest=digest, filename=filename,
                        stats_json=json.dumps({**summarize(payload['samples']), 'interruptions': len(body.interruptions)}))
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            old = db.get(Recording, rid)
            if old and old.owner == owner and old.digest == digest:
                return recording_dict(old)
            path.unlink(missing_ok=True)
            raise HTTPException(409, 'Recording ID conflict')
        return recording_dict(row)


@api.get('/api/v1/recordings')
def recordings(owner: Owner, session_id: UUID | None = None, label: str | None = None,
               limit: int = Query(500, ge=1, le=1000), offset: int = Query(0, ge=0)):
    query = select(Recording).where(Recording.owner == owner)
    if session_id:
        query = query.where(Recording.session_id == str(session_id))
    if label:
        query = query.where(Recording.label == label)
    with SessionLocal() as db:
        return [recording_dict(r) for r in db.scalars(query.order_by(Recording.started_at.desc()).limit(limit).offset(offset))]


@api.get('/api/v1/recordings/{recording_id}')
def download(recording_id: UUID, owner: Owner, format: str = Query('json', pattern='^(json|csv)$')):
    with SessionLocal() as db:
        row = db.get(Recording, str(recording_id))
        if not row or row.owner != owner:
            raise HTTPException(404, 'Recording not found')
        path = settings.data_dir / row.filename
        if not path.is_file():
            raise HTTPException(503, 'Recording file unavailable; contact administrator')
        if format == 'csv':
            return Response(csv_bytes(json.loads(path.read_bytes())), media_type='text/csv', headers={'Content-Disposition': f'attachment; filename="{row.id}.csv"'})
        return FileResponse(path, media_type='application/json', filename=f'{row.id}.json')


@api.delete('/api/v1/recordings/{recording_id}', status_code=204)
def delete_recording(recording_id: UUID, owner: Owner):
    with SessionLocal() as db:
        row = db.get(Recording, str(recording_id))
        if not row or row.owner != owner:
            raise HTTPException(404, 'Recording not found')
        path = settings.data_dir / row.filename
        db.delete(row)
        db.commit()
        path.unlink(missing_ok=True)
    return Response(status_code=204)


@api.get('/api/v1/datasets/export')
def export(owner: Owner, session_id: UUID | None = None):
    query = select(Recording).where(Recording.owner == owner)
    if session_id:
        query = query.where(Recording.session_id == str(session_id))
    with SessionLocal() as db:
        rows = list(db.scalars(query.limit(501)))
        if len(rows) > 500:
            raise HTTPException(422, 'Export limited to 500 recordings; select a session')
        total = sum((settings.data_dir / r.filename).stat().st_size for r in rows)
        if total > 512 * 1024 * 1024:
            raise HTTPException(422, 'Export exceeds 512 MiB; select a session')
        fd, name = tempfile.mkstemp(suffix='.zip')
        os.close(fd)
        try:
            with zipfile.ZipFile(name, 'w', zipfile.ZIP_DEFLATED) as archive:
                manifest = {'schema_version': 1, 'recordings': [r.id for r in rows],
                            'sessions': [SessionIn.model_validate(session_dict(s)).model_dump(mode='json') for s in db.scalars(select(Session).where(Session.owner == owner))],
                            'units': {'user_acceleration': 'g', 'rotation_rate': 'rad/s', 'gravity': 'g', 't': 's'}, 'synthetic': False}
                archive.writestr('manifest.json', json.dumps(manifest, indent=2))
                for r in rows:
                    archive.write(settings.data_dir / r.filename, f'recordings/{r.id}.json')
        except Exception:
            Path(name).unlink(missing_ok=True)
            raise
    return FileResponse(name, media_type='application/zip', filename='silentlink-dataset.zip', background=BackgroundTask(Path(name).unlink, missing_ok=True))


class BodyLimit:
    """Cap streamed bodies too; Content-Length alone is not a security boundary."""
    def __init__(self, wrapped):
        self.wrapped = wrapped

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.wrapped(scope, receive, send)
        chunks = []
        size = 0
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            size += len(message.get('body', b''))
            if size > settings.max_upload_bytes:
                return await JSONResponse({'detail': 'Request exceeds upload limit'}, status_code=413)(scope, receive, send)
            chunks.append(message)
            if not message.get('more_body', False):
                break
        index = 0
        async def replay():
            nonlocal index
            if index < len(chunks):
                message = chunks[index]
                index += 1
                return message
            return await receive()
        await self.wrapped(scope, replay, send)


app = BodyLimit(api)
