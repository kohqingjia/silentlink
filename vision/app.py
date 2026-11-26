"""Owner-scoped webcam jobs; one warm, cancellable inference worker."""
import asyncio
from collections import defaultdict, deque
from contextlib import asynccontextmanager, contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
from urllib.parse import unquote
import uuid

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
import httpx

from metrics import personal_match, score, words

DATA = Path(os.getenv("DATA_DIR", "/data"))
MAX_BYTES = 12 * 1024 * 1024
TERMINAL = {"complete", "failed", "cancelled"}
MODES = {"transcribe", "test", "teach", "personal", "personal_test"}
jobs = {}
queue = asyncio.Queue(maxsize=8)
auth_cache = {}
rate = defaultdict(deque)
engine = {"stage": "starting", "message": "Starting the lip-reading service", "percent": None}
process = None
active_id = None


@contextmanager
def db():
    con = sqlite3.connect(DATA / "research.sqlite3")
    con.row_factory = sqlite3.Row
    try:
        with con:
            yield con
    finally:
        con.close()


def save(job):
    with db() as con:
        con.execute("INSERT OR REPLACE INTO jobs (id, owner, mode, created, document) VALUES (?, ?, ?, ?, ?)",
                    (job["id"], job["owner"], job["mode"], job["created"], json.dumps(job)))


def get_job(job_id, owner):
    job = jobs.get(job_id)
    if job is None:
        with db() as con:
            row = con.execute("SELECT document FROM jobs WHERE id=? AND owner=?", (job_id, owner)).fetchone()
        job = json.loads(row["document"]) if row else None
    if not job or job["owner"] != owner:
        raise HTTPException(404, "Recording not found")
    return job


def training(owner):
    with db() as con:
        rows = con.execute("SELECT document FROM jobs WHERE owner=? AND mode='teach' ORDER BY created", (owner,)).fetchall()
    return [j for row in rows if (j := json.loads(row["document"]))["stage"] == "complete"]


def snapshot(owner):
    return [{"id": j["id"], "label": j["reference"], "embedding": j["result"]["embedding"]} for j in training(owner)]


async def owner(request: Request):
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer ") or len(authorization) > 512:
        raise HTTPException(401, "Connect with your dashboard key first")
    digest = hashlib.sha256(authorization.encode()).hexdigest()
    cached = auth_cache.get(digest)
    if cached and cached[1] > time.time():
        return cached[0]
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(os.getenv("AUTH_URL", "http://silentlink-api:8000/api/v1/me"), headers={"Authorization": authorization})
        if response.status_code in (401, 403):
            raise HTTPException(401, "That key was not accepted. Use your dashboard key.")
        if response.status_code != 200:
            raise HTTPException(503, "Account service is busy. Please retry shortly.")
        identity = response.json()["owner"]
    except httpx.HTTPError:
        raise HTTPException(503, "Account service is temporarily unavailable")
    if len(auth_cache) > 512:
        auth_cache.clear()
    auth_cache[digest] = (identity, time.time() + 30)
    return identity


def public(job):
    result = {k: v for k, v in job.items() if k not in {"owner", "path", "examples"}}
    if "result" in result:
        result["result"] = {k: v for k, v in result["result"].items() if k != "embedding"}
    result["elapsed_s"] = round(time.time() - job["created"], 1) if job["stage"] not in TERMINAL else round(job.get("finished", job["created"]) - job["created"], 1)
    queued = sorted([j for j in jobs.values() if j["stage"] == "queued"], key=lambda j: j["created"])
    result["queue_position"] = next((i + 1 for i, j in enumerate(queued) if j["id"] == job["id"]), 0)
    # Measured previous completions only; no invented progress for a first run.
    estimates = [j["result"]["processing_s"] for j in jobs.values() if j["stage"] == "complete" and (j["mode"] == "teach") == (job["mode"] == "teach") and "result" in j]
    result["eta_s"] = None
    if len(estimates) >= 2 and job["stage"] not in TERMINAL:
        average = sum(estimates[-8:]) / len(estimates[-8:])
        remaining = average * (1 + result["queue_position"]) - (time.time() - job.get("started", time.time()))
        result["eta_s"] = max(0, round(remaining))
    return result


async def start_worker():
    global process
    engine.update(stage="loading_model", percent=None, message="Loading the model; first startup may take a minute")
    process = await asyncio.create_subprocess_exec(sys.executable, "worker.py", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        line = await asyncio.wait_for(process.stdout.readline(), timeout=max(1, deadline - time.monotonic()))
        if not line:
            raise RuntimeError("Worker exited during startup")
        event = json.loads(line)
        engine.update(event)
        if event["stage"] == "ready":
            return
        if event["stage"] == "unavailable":
            raise RuntimeError("Model unavailable")
    raise TimeoutError("Model startup timed out")


async def stop_worker():
    global process
    engine.update(stage="restarting", percent=None, message="Restarting the model; your queued recordings will wait")
    if process and process.returncode is None:
        process.kill()
        await process.wait()
    process = None


async def supervise():
    global active_id
    while True:
        try:
            if process is None or process.returncode is not None:
                await start_worker()
            job_id = await queue.get()
            job = jobs.get(job_id)
            if not job or job["stage"] == "cancelled":
                queue.task_done()
                continue
            active_id = job_id
            job.update(stage="checking_video", started=time.time(), percent=None)
            save(job)
            # Labels and references remain outside the inference process.
            process.stdin.write((json.dumps({"path": job["path"], "decode": job["mode"] in {"transcribe", "test"}}) + "\n").encode())
            await process.stdin.drain()
            deadline = time.monotonic() + 180
            try:
                while True:
                    if job["stage"] == "cancelled":
                        await stop_worker()
                        break
                    if time.monotonic() > deadline:
                        raise TimeoutError()
                    try:
                        line = await asyncio.wait_for(process.stdout.readline(), timeout=1)
                    except asyncio.TimeoutError:
                        continue
                    if not line:
                        raise RuntimeError("Worker stopped")
                    event = json.loads(line)
                    if event["stage"] == "complete":
                        result = event["result"]
                        if job["mode"] in {"personal", "personal_test"}:
                            match = personal_match(result["embedding"], job["examples"])
                            result.update(match)
                            result["model"] = "Personal vocabulary · frozen Auto-AVSR visual features"
                            result["training_ids"] = [e["id"] for e in job["examples"]]
                        if job["mode"] in {"test", "personal_test"}:
                            result["score"] = score(job["reference"], result["text"])
                        job.update(stage="complete", percent=100, message="Recording processed", result=result)
                        break
                    job.update(event)
                    if event["stage"] == "failed":
                        break
            except Exception as exc:
                if job["stage"] != "cancelled":
                    job.update(stage="failed", percent=None, error="Processing exceeded 3 minutes. Try a shorter clip." if isinstance(exc, TimeoutError) else "The model restarted unexpectedly. Please retry.")
                await stop_worker()
            finally:
                job["finished"] = time.time()
                job.pop("examples", None)
                if job["stage"] != "complete" or not job["retain"]:
                    Path(job["path"]).unlink(missing_ok=True)
                save(job)
                active_id = None
                queue.task_done()
        except asyncio.CancelledError:
            await stop_worker()
            raise
        except Exception:
            await stop_worker()
            engine.update(stage="unavailable", percent=None, message="The model is unavailable. Automatic retry in 30 seconds.")
            await asyncio.sleep(30)


async def cleanup():
    while True:
        cutoff = time.time() - 7 * 86400
        with db() as con:
            rows = con.execute("SELECT id, document FROM jobs WHERE mode!='teach' AND created<?", (cutoff,)).fetchall()
            for row in rows:
                Path(json.loads(row["document"])["path"]).unlink(missing_ok=True)
                jobs.pop(row["id"], None)
            con.execute("DELETE FROM jobs WHERE mode!='teach' AND created<?", (cutoff,))
        for key in list(jobs):
            if jobs[key]["stage"] in TERMINAL and jobs[key].get("finished", 0) < time.time() - 3600:
                jobs.pop(key)
        await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(app):
    DATA.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT, mode TEXT, created REAL, document TEXT)")
        con.execute("CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, created)")
        rows = con.execute("SELECT document FROM jobs").fetchall()
    for row in rows:
        job = json.loads(row["document"])
        if job["stage"] not in TERMINAL:
            job.update(stage="failed", finished=time.time(), error="Server restarted. Please record again.")
            Path(job["path"]).unlink(missing_ok=True)
            save(job)
    referenced = {Path(json.loads(row["document"])["path"]).name for row in rows}
    for path in DATA.glob("*.video"):
        if path.name not in referenced:
            path.unlink(missing_ok=True)
    task, cleaner = asyncio.create_task(supervise()), asyncio.create_task(cleanup())
    yield
    task.cancel()
    cleaner.cancel()
    await asyncio.gather(task, cleaner, return_exceptions=True)


app = FastAPI(title="SilentLink camera research", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/api/vision/status")
async def status():
    return {**engine, "ready": engine["stage"] == "ready", "hardware": "CPU", "max_clip_s": 8,
            "queue_depth": queue.qsize(), "active": active_id is not None, "streaming": "short utterances", "model": "Auto-AVSR"}


@app.get("/health")
async def health():
    return {"ok": True, "model_ready": engine["stage"] == "ready"}


@app.post("/api/vision/jobs", status_code=202)
async def create(request: Request, identity: str = Depends(owner)):
    try:
        job_id = str(uuid.UUID(request.headers.get("x-recording-id", str(uuid.uuid4()))))
    except ValueError:
        raise HTTPException(422, "Invalid recording ID")
    with db() as con:
        existing = con.execute("SELECT document FROM jobs WHERE id=?", (job_id,)).fetchone()
    if existing:
        previous = json.loads(existing["document"])
        if previous["owner"] != identity:
            raise HTTPException(409, "Recording ID already used")
        return public(previous)
    mode = request.headers.get("x-recording-mode", "transcribe")
    reference = unquote(request.headers.get("x-reference-text", "")).strip()
    if mode == "teach":
        reference = " ".join(words(reference))
    retain = mode == "teach" and request.headers.get("x-save-sample") == "yes"
    if mode not in MODES or len(reference) > 200:
        raise HTTPException(422, "Invalid mode or reference (maximum 200 characters)")
    if mode in {"teach", "test", "personal_test"} and not words(reference):
        raise HTTPException(422, "Enter a word or phrase before recording")
    if mode == "teach" and len(words(reference)) > 3:
        raise HTTPException(422, "Teach one word or a short phrase of up to three words")
    if engine["stage"] != "ready":
        raise HTTPException(503, engine["message"])
    if queue.full() or sum(j["stage"] not in TERMINAL and j["owner"] == identity for j in jobs.values()) >= 2:
        raise HTTPException(429, "Your previous recording is still processing. Wait or cancel it first.")
    now = time.time()
    rate[identity] = deque(t for t in rate[identity] if t > now - 60)
    if len(rate[identity]) >= 20:
        raise HTTPException(429, "Please wait a minute before submitting more recordings")
    if mode == "teach" and len(training(identity)) >= 200:
        raise HTTPException(409, "Your 200-sample vocabulary is full. Delete older samples first.")
    examples = snapshot(identity) if mode in {"personal", "personal_test"} else []
    if mode in {"personal", "personal_test"}:
        counts = defaultdict(int)
        for e in examples:
            counts[e["label"]] += 1
        if sum(v >= 3 for v in counts.values()) < 2:
            raise HTTPException(409, "Teach at least two words with three takes each, then test on a new recording.")
    rate[identity].append(now)
    path = DATA / f"{job_id}.video"
    size = 0
    owns_file = False
    try:
        with path.open("xb") as file:
            owns_file = True
            async with asyncio.timeout(60):
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise HTTPException(413, "Video exceeds 12 MB. Record a shorter clip.")
                    file.write(chunk)
        if size < 100:
            raise HTTPException(422, "Recording was empty. Please try again.")
        job = {"id": job_id, "owner": identity, "mode": mode, "reference": reference,
               "retain": retain, "path": str(path), "created": time.time(), "stage": "queued",
               "percent": None, "message": "Waiting for the lip-reading model", "examples": examples}
        # Recheck after upload yields to other requests; no invisible queue overflow.
        if queue.full() or sum(j["stage"] not in TERMINAL and j["owner"] == identity for j in jobs.values()) >= 2:
            raise HTTPException(429, "Queue filled while uploading. Please retry shortly.")
        save(job)
        jobs[job_id] = job
        queue.put_nowait(job_id)
        return public(job)
    except FileExistsError:
        raise HTTPException(409, "This recording is already uploading. Wait a moment and retry.")
    except TimeoutError:
        if owns_file:
            path.unlink(missing_ok=True)
        raise HTTPException(408, "Upload timed out. Please retry.")
    except BaseException:
        if owns_file:
            path.unlink(missing_ok=True)
        raise


@app.get("/api/vision/jobs/{job_id}")
async def read(job_id: str, identity: str = Depends(owner)):
    return public(get_job(job_id, identity))


@app.post("/api/vision/jobs/{job_id}/cancel")
async def cancel(job_id: str, identity: str = Depends(owner)):
    job = get_job(job_id, identity)
    if job["stage"] not in TERMINAL:
        job.update(stage="cancelled", finished=time.time(), message="Recording cancelled", percent=None)
        if job_id != active_id:
            Path(job["path"]).unlink(missing_ok=True)
        save(job)
    return public(job)


@app.get("/api/vision/history")
async def history(identity: str = Depends(owner)):
    with db() as con:
        rows = con.execute("SELECT document FROM jobs WHERE owner=? ORDER BY created DESC LIMIT 500", (identity,)).fetchall()
    return {"recordings": [public(json.loads(row["document"])) for row in rows]}


@app.delete("/api/vision/jobs/{job_id}")
async def delete(job_id: str, identity: str = Depends(owner)):
    job = get_job(job_id, identity)
    if job["stage"] not in TERMINAL or job_id == active_id:
        raise HTTPException(409, "Cancel processing before deleting this recording")
    Path(job["path"]).unlink(missing_ok=True)
    with db() as con:
        con.execute("DELETE FROM jobs WHERE id=? AND owner=?", (job_id, identity))
    jobs.pop(job_id, None)
    return {"deleted": True}


@app.get("/api/vision/jobs/{job_id}/video")
async def video(job_id: str, identity: str = Depends(owner)):
    job = get_job(job_id, identity)
    if job["stage"] != "complete" or not job["retain"] or not Path(job["path"]).is_file():
        raise HTTPException(404, "This recording was not retained")
    return FileResponse(job["path"], filename=f"silentlink-{job_id}.video", media_type="application/octet-stream")


@app.middleware("http")
async def private_responses(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response
