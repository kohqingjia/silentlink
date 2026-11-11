import os
import tempfile
from pathlib import Path
import hashlib
import pytest
from fastapi.testclient import TestClient

TEST_ROOT = Path(tempfile.mkdtemp(prefix='silentlink-tests-'))
os.environ['DATABASE_URL'] = f'sqlite:///{TEST_ROOT}/test.sqlite'
os.environ['DATA_DIR'] = str(TEST_ROOT / 'recordings')
from app.db import APIKey, Base, SessionLocal, engine
from app.main import app, buckets


@pytest.fixture
def client():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    buckets.clear()
    with SessionLocal.begin() as db:
        for token, owner in [('test-only-a', 'alice'), ('test-only-b', 'bob')]:
            db.add(APIKey(digest=hashlib.sha256(token.encode()).hexdigest(), owner=owner, device='test'))
    with TestClient(app) as client:
        yield client


@pytest.fixture
def auth():
    return {'Authorization': 'Bearer test-only-a'}
