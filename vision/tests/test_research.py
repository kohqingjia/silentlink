import asyncio
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import time
import uuid

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from metrics import score, personal_match
spec = importlib.util.spec_from_file_location("vision_api", ROOT / "app.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "DATA", tmp_path)
    monkeypatch.setattr(api, "jobs", {})
    monkeypatch.setattr(api, "queue", asyncio.Queue(maxsize=8))
    monkeypatch.setattr(api, "engine", {"stage": "ready", "message": "ready", "percent": 100})
    api.rate.clear()
    api.auth_cache.clear()
    with api.db() as con:
        con.execute("CREATE TABLE jobs(id TEXT PRIMARY KEY, owner TEXT, mode TEXT, created REAL, document TEXT)")
    api.app.dependency_overrides[api.owner] = lambda: "alice"
    yield TestClient(api.app)  # No ML process in unit tests; real inference has a separate smoke test.
    api.app.dependency_overrides.clear()


def post(client, **headers):
    return client.post("/api/vision/jobs", content=b"test-fixture" * 20, headers=headers)


def test_wer_counts_insertions_and_can_exceed_100():
    assert score("Hello, WORLD!", "hello world")["exact_match"]
    result = score("one", "two three four")
    assert result["wer_percent"] == 300
    assert result["errors"] == 3
    assert score("a b c", "a c")["deletions"] == 1
    assert score("a", "")["wer_percent"] == 100
    with pytest.raises(ValueError):
        score("...", "a")


def test_ownership_and_private_embeddings(client):
    job_id = post(client).json()["id"]
    api.jobs[job_id]["result"] = {"text": "hello", "embedding": [1, 2]}
    response = client.get(f"/api/vision/jobs/{job_id}")
    assert response.status_code == 200
    assert "owner" not in response.json() and "path" not in response.json()
    assert "embedding" not in response.json()["result"]
    api.app.dependency_overrides[api.owner] = lambda: "bob"
    for method, path in [("get", ""), ("post", "/cancel"), ("delete", ""), ("get", "/video")]:
        assert getattr(client, method)(f"/api/vision/jobs/{job_id}{path}").status_code == 404
    assert client.get("/api/vision/history").json()["recordings"] == []


def test_unauthenticated_request_rejected(client):
    api.app.dependency_overrides.clear()
    assert post(client).status_code == 401
    assert client.get("/api/vision/history").status_code == 401
    assert client.get("/api/vision/status").status_code == 200


def test_upload_bounds_and_no_leftover_file(client, monkeypatch):
    monkeypatch.setattr(api, "MAX_BYTES", 100)
    assert post(client).status_code == 413
    assert not list(api.DATA.glob("*.video"))
    assert client.post("/api/vision/jobs", content=b"").status_code == 422
    assert not list(api.DATA.glob("*.video"))


def test_queue_limit_cancel_and_idempotency(client):
    ident = str(uuid.uuid4())
    first = post(client, **{"x-recording-id": ident}).json()
    second = post(client, **{"x-recording-id": ident}).json()
    assert first["id"] == second["id"] and api.queue.qsize() == 1
    assert first["eta_s"] is None and first["percent"] is None
    assert post(client).status_code == 202
    assert post(client).status_code == 429
    assert client.post(f"/api/vision/jobs/{ident}/cancel").json()["stage"] == "cancelled"
    assert not (api.DATA / f"{ident}.video").exists()
    assert post(client).status_code == 202


def test_test_reference_required_and_personal_training_separate(client):
    assert post(client, **{"x-recording-mode": "test"}).status_code == 422
    assert post(client, **{"x-recording-mode": "personal_test", "x-reference-text": "hello"}).status_code == 409
    job = post(client, **{"x-recording-mode": "test", "x-reference-text": "hello"}).json()
    assert job["reference"] == "hello"
    assert api.snapshot("alice") == []


def test_model_unavailable_fails_early(client):
    api.engine.update(stage="loading_model")
    assert post(client).status_code == 503
    assert not list(api.DATA.glob("*.video"))


def test_personal_prediction_rejects_ambiguity():
    examples = [{"label": label, "embedding": vector} for label, vector in [("water", [1, 0]), ("hello", [0, 1])] for _ in range(3)]
    assert personal_match([1, 0], examples)["text"] == "water"
    assert not personal_match([1, 1], examples)["accepted"]
    assert not personal_match([1, 0], examples[:1])["accepted"]


def test_cancellation_terminates_active_worker(client, monkeypatch):
    class FakeProcess:
        returncode = None
        killed = False
        def kill(self):
            self.killed = True
        async def wait(self):
            self.returncode = -9
    process = FakeProcess()
    monkeypatch.setattr(api, "process", process)
    asyncio.run(api.stop_worker())
    assert process.killed and api.process is None
    assert api.engine["stage"] == "restarting"
