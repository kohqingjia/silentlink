"""Synthetic geometry checks contracts and math, never lip-reading accuracy."""
from copy import deepcopy
from pathlib import Path
import sys
import uuid

import numpy as np
import pytest
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mesh import Capture, LIPS, distance, prepare, router


def capture(style=0, variation=0):
    frames = []
    for i in range(30):
        xyz = np.tile([0.5, 0.5, 0], (478, 1)).astype(float)
        xyz[33] = [.3, .35, 0]
        xyz[263] = [.7, .35, 0]
        for j, index in enumerate(LIPS):
            angle = 2 * np.pi * j / len(LIPS)
            xyz[index] = [.5 + (.07 + style * .09) * np.cos(angle), .6 + .03 * np.sin(angle), 0]
        opening = .015 + .035 * (1 + np.sin(i / 5 + variation))
        xyz[13] = [.5, .6 - opening / 2, 0]
        xyz[14] = [.5, .6 + opening / 2, 0]
        frames.append({"t": i * 50, "faces": 1, "xyz": xyz.reshape(-1).tolist(), "pose": np.eye(4).reshape(-1).tolist()})
    return {"schema_version": "mediapipe-478-v1", "width": 640, "height": 480, "frames": frames}


@pytest.fixture
def client(tmp_path):
    async def owner(authorization: str = Header(default="")):
        if authorization not in ("Bearer alice", "Bearer bob"):
            raise HTTPException(401)
        return authorization.split()[1]
    app = FastAPI()
    app.include_router(router(owner, tmp_path))
    with TestClient(app, headers={"Authorization": "Bearer alice"}) as client:
        yield client


def save(client, label="please bring water", sample=None, ident=None):
    return client.post("/api/vision/mesh/examples", json={"id": ident or str(uuid.uuid4()), "label": label, "capture": sample or capture()})


def test_save_replay_delete_are_private_and_idempotent(client):
    ident = str(uuid.uuid4())
    assert save(client, ident=ident).status_code == 201
    assert save(client, ident=ident).status_code == 201
    assert save(client, label="different words", ident=ident).status_code == 409
    library = client.get("/api/vision/mesh/library").json()
    assert len(library["examples"]) == 1
    assert "capture" not in library["examples"][0]
    assert "features" not in library["examples"][0]
    path = f"/api/vision/mesh/examples/{ident}"
    assert client.get(path).json()["capture"] == capture()
    for method in (client.get, client.delete):
        assert method(path, headers={"Authorization": "Bearer bob"}).status_code == 404
        assert method(path, headers={"Authorization": ""}).status_code == 401
    assert client.get("/api/vision/mesh/library", headers={"Authorization": "Bearer bob"}).json()["examples"] == []
    assert client.delete(path).status_code == 200
    assert client.get(path).status_code == 404


@pytest.mark.parametrize("problem", ["video", "image", "nan", "missing_pose", "multiple_faces", "static", "slow", "unordered", "missing_face"])
def test_rejects_pixels_and_unusable_geometry(client, problem):
    sample = capture()
    if problem in ("video", "image"):
        sample[problem] = "data:video/webm;base64,AA=="
    elif problem == "nan":
        sample["frames"][0]["xyz"][0] = "NaN"
    elif problem == "missing_pose":
        sample["frames"][0]["pose"] = []
    elif problem == "multiple_faces":
        sample["frames"][0]["faces"] = 2
    elif problem == "static":
        for frame in sample["frames"]:
            frame["xyz"] = sample["frames"][0]["xyz"][:]
    elif problem == "slow":
        for i, frame in enumerate(sample["frames"]):
            frame["t"] = i * 250
    elif problem == "unordered":
        sample["frames"][1]["t"] = 0
    else:
        for frame in sample["frames"][:6]:
            frame.update(faces=0, xyz=[], pose=[])
    assert save(client, sample=sample).status_code == 422
    assert client.get("/api/vision/mesh/library").json()["examples"] == []


def test_fresh_prediction_is_independent_of_expected_text(client):
    for style, label in [(0, "please bring water"), (1, "thank you today")]:
        for variation in [0, .1, .2]:
            assert save(client, label, capture(style, variation)).status_code == 201
    test = {"capture": capture(0, .08), "reference": "please bring water"}
    correct = client.post("/api/vision/mesh/predict", json=test)
    assert correct.status_code == 200
    assert correct.json()["text"] == "please bring water"
    assert correct.json()["score"]["exact_match"]
    test["reference"] = "completely different expected words"
    wrong = client.post("/api/vision/mesh/predict", json=test).json()
    assert wrong["text"] == correct.json()["text"]
    assert wrong["candidates"] == correct.json()["candidates"]
    assert not wrong["score"]["exact_match"]
    assert len(client.get("/api/vision/mesh/library").json()["tests"]) == 2
    # Saved training takes may be replayed but cannot be presented as fresh tests.
    test["capture"] = capture(0, 0)
    assert client.post("/api/vision/mesh/predict", json=test).status_code == 409


def test_motion_comparison_preserves_time_and_removes_position():
    original = capture()
    shifted = deepcopy(original)
    for frame in shifted["frames"]:
        xyz = np.array(frame["xyz"]).reshape(478, 3)
        frame["xyz"] = (xyz + [.1, -.08, .01]).reshape(-1).tolist()
    a, _ = prepare(Capture.model_validate(original))
    b, _ = prepare(Capture.model_validate(shifted))
    assert distance(a, b) < 1e-6
    assert distance(a, a[::-1]) > .001


def test_untrained_workspace_and_upload_limit(client):
    assert client.post("/api/vision/mesh/predict", json={"capture": capture()}).status_code == 409
    assert client.post("/api/vision/mesh/examples", content=b" " * (8 * 1024 * 1024 + 1)).status_code == 413
