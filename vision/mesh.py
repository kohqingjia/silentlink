"""Motion-only phrase experiments. No video/image fields are accepted or stored."""
import asyncio
from collections import defaultdict, deque
from contextlib import contextmanager
import json
import math
import sqlite3
import time
import uuid

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from metrics import score, words

# MediaPipe's lip contour indices; the whole 478-point mesh is retained for replay.
LIPS = [0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87, 88, 91, 95, 146,
        178, 181, 185, 191, 267, 269, 270, 291, 308, 310, 311, 312, 314, 317, 318,
        321, 324, 375, 402, 405, 409, 415]
VERSION = "mediapipe-478-v1"
FEATURE_VERSION = "pose-normalized-lips-dtw-v1"


class Frame(BaseModel):
    model_config = ConfigDict(extra="forbid")
    t: float = Field(ge=0, le=8500, allow_inf_nan=False)
    faces: int = Field(ge=0, le=2, strict=True)
    xyz: list[float] = Field(max_length=1434)
    pose: list[float] = Field(max_length=16)


class Capture(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: str
    width: int = Field(ge=160, le=1920, strict=True)
    height: int = Field(ge=120, le=1920, strict=True)
    frames: list[Frame] = Field(min_length=10, max_length=220)


class Example(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: uuid.UUID
    label: str = Field(min_length=1, max_length=200)
    capture: Capture


class Attempt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capture: Capture
    reference: str = Field(default="", max_length=200)


def prepare(capture):
    if capture.schema_version != VERSION:
        raise ValueError("Unsupported mesh format. Refresh the website and record again.")
    times = np.array([f.t for f in capture.frames])
    if np.any(np.diff(times) <= 0) or times[-1] - times[0] < 400:
        raise ValueError("Capture at least half a second with increasing frame timestamps.")
    duration = (times[-1] - times[0]) / 1000
    if len(times) / duration < 10 or np.max(np.diff(times)) > 350:
        raise ValueError("Tracking was too slow or interrupted. Close other tabs and try again.")
    if any(f.faces > 1 for f in capture.frames):
        raise ValueError("Keep only one face in view while recording.")
    features, valid_times, openings = [], [], []
    for frame in capture.frames:
        if frame.faces != 1:
            if frame.xyz or frame.pose:
                raise ValueError("Missing-face frames must not include geometry.")
            continue
        if len(frame.xyz) != 1434 or len(frame.pose) != 16:
            raise ValueError("Each tracked frame needs 478 XYZ points and its pose matrix.")
        xyz = np.asarray(frame.xyz, dtype=np.float32).reshape(478, 3)
        matrix = np.asarray(frame.pose, dtype=np.float32).reshape(4, 4).T  # MediaPipe column-major
        if not np.isfinite(xyz).all() or not np.isfinite(matrix).all() or np.max(np.abs(xyz)) > 4 or np.max(np.abs(matrix)) > 10000:
            raise ValueError("Invalid face coordinates.")
        # Image-height units, camera convention y-up / z-towards viewer.
        xyz[:, [0, 2]] *= capture.width / capture.height
        xyz[:, [1, 2]] *= -1
        rotation = matrix[:3, :3]
        scale = np.linalg.norm(rotation, axis=0).mean()
        if scale < 1e-5:
            raise ValueError("Invalid head pose.")
        normalized_rotation = rotation / scale
        if not np.allclose(normalized_rotation.T @ normalized_rotation, np.eye(3), atol=0.12):
            raise ValueError("Unstable head pose. Face the camera and try again.")
        xyz = xyz @ normalized_rotation
        eye_distance = np.linalg.norm(xyz[33] - xyz[263])
        if eye_distance < 0.01:
            raise ValueError("Move closer so your face is clear.")
        mouth = (xyz[LIPS] - xyz[LIPS].mean(axis=0)) / eye_distance
        features.append(mouth.reshape(-1))
        openings.append(float(np.linalg.norm(xyz[13] - xyz[14]) / eye_distance))
        valid_times.append(frame.t)
    coverage = len(features) / len(capture.frames)
    if coverage < 0.85:
        raise ValueError("Your face was lost too often. Keep it visible throughout the sentence.")
    if np.ptp(openings) < 0.015:
        raise ValueError("Not enough mouth movement detected. Mouth the phrase naturally, then stop.")
    # Keep temporal order. Interpolate timestamped motion to 64 samples for bounded DTW work.
    points = np.stack(features)
    target_times = np.linspace(valid_times[0], valid_times[-1], 64)
    sequence = np.stack([np.interp(target_times, valid_times, points[:, i]) for i in range(points.shape[1])], axis=1).astype(np.float32)
    return sequence, {"duration_s": round(duration, 2), "frames": len(capture.frames),
                      "tracking_percent": round(coverage * 100), "observed_fps": round(len(times) / duration, 1)}


def distance(a, b):
    # DTW follows lip motion through time, allowing different speaking speeds.
    costs = np.sqrt(np.mean((a[:, None, :] - b[None, :, :]) ** 2, axis=-1))
    n, m = costs.shape
    previous = np.full(m + 1, np.inf)
    previous[0] = 0
    for i in range(1, n + 1):
        current = np.full(m + 1, np.inf)
        for j in range(max(1, i - 16), min(m, i + 16) + 1):
            current[j] = costs[i-1, j-1] + min(previous[j], current[j-1], previous[j-1])
        previous = current
    return float(previous[m] / max(n, m))


def predict(sequence, examples):
    groups = defaultdict(list)
    for example in examples:
        groups[example["label"]].append(distance(sequence, np.array(example["features"], dtype=np.float32)))
    candidates = sorted([{"text": label, "distance": round(float(np.mean(sorted(values)[:3])), 5), "samples": len(values)}
                         for label, values in groups.items() if len(values) >= 3], key=lambda c: c["distance"])
    if len(candidates) < 2:
        raise ValueError("Save three takes each of at least two different phrases before testing.")
    best, runner_up = candidates[:2]
    accepted = best["distance"] < 0.12 and runner_up["distance"] - best["distance"] > max(0.008, best["distance"] * 0.15)
    return {"text": best["text"] if accepted else "", "accepted": bool(accepted), "candidates": candidates[:3],
            "training_ids": [e["id"] for e in examples], "feature_version": FEATURE_VERSION,
            "reason": "Closest taught phrase" if accepted else "Uncertain. Record another take; similar lip movements can be ambiguous."}


def router(owner_dependency, data_dir):
    api = APIRouter(prefix="/api/vision/mesh")
    rates = defaultdict(deque)
    gate = asyncio.Semaphore(1)

    @contextmanager
    def database():
        data_dir.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(data_dir / "mesh.sqlite3")
        con.row_factory = sqlite3.Row
        try:
            with con:
                con.execute("CREATE TABLE IF NOT EXISTS examples(id TEXT PRIMARY KEY, owner TEXT, label TEXT, created REAL, metadata TEXT, capture TEXT, features TEXT)")
                con.execute("CREATE INDEX IF NOT EXISTS mesh_owner ON examples(owner)")
                con.execute("CREATE TABLE IF NOT EXISTS tests(id TEXT PRIMARY KEY, owner TEXT, created REAL, result TEXT)")
                con.execute("DELETE FROM tests WHERE created<?", (time.time() - 7 * 86400,))
                con.commit()
                yield con
        finally:
            con.close()

    async def body(request, schema, identity):
        now = time.time()
        rates[identity] = deque(t for t in rates[identity] if t > now - 60)
        if len(rates[identity]) >= 20:
            raise HTTPException(429, "Please wait a minute before submitting more motion recordings.")
        rates[identity].append(now)
        chunks, size = [], 0
        try:
            async with asyncio.timeout(45):
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > 8 * 1024 * 1024:
                        raise HTTPException(413, "Motion recording exceeds 8 MB.")
                    chunks.append(chunk)
            return schema.model_validate_json(b"".join(chunks))
        except ValidationError:
            raise HTTPException(422, "Invalid motion data. Only the documented numeric mesh fields are accepted; images and video are not allowed.")
        except TimeoutError:
            raise HTTPException(408, "Motion upload timed out. Please retry.")

    @api.get("/library")
    async def library(identity: str = Depends(owner_dependency)):
        with database() as con:
            rows = con.execute("SELECT id,label,created,metadata FROM examples WHERE owner=? ORDER BY created DESC", (identity,)).fetchall()
            results = con.execute("SELECT result FROM tests WHERE owner=? ORDER BY created DESC LIMIT 500", (identity,)).fetchall()
        return {"examples": [{"id": r["id"], "label": r["label"], "created": r["created"], **json.loads(r["metadata"])} for r in rows],
                "tests": [json.loads(r["result"]) for r in results], "model": FEATURE_VERSION}

    @api.post("/examples", status_code=201)
    async def save_example(request: Request, identity: str = Depends(owner_dependency)):
        example = await body(request, Example, identity)
        label = " ".join(words(example.label))
        if not 1 <= len(words(label)) <= 16:
            raise HTTPException(422, "Use a short sentence of 1–16 words that fits within eight seconds.")
        try:
            sequence, meta = prepare(example.capture)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        with database() as con:
            con.execute("BEGIN IMMEDIATE")
            existing = con.execute("SELECT owner, label, capture FROM examples WHERE id=?", (str(example.id),)).fetchone()
            payload = example.capture.model_dump_json()
            if existing:
                if existing["owner"] != identity or existing["label"] != label or existing["capture"] != payload:
                    raise HTTPException(409, "Recording ID already used for a different example.")
                return {"saved": True, "id": str(example.id), "label": label, **meta}
            if con.execute("SELECT count(*) FROM examples WHERE owner=?", (identity,)).fetchone()[0] >= 200:
                raise HTTPException(409, "Your 200-example motion library is full. Delete older takes first.")
            con.execute("INSERT INTO examples VALUES (?, ?, ?, ?, ?, ?, ?)", (str(example.id), identity, label, time.time(), json.dumps(meta), payload, json.dumps(sequence.tolist())))
        return {"saved": True, "id": str(example.id), "label": label, **meta}

    @api.get("/examples/{example_id}")
    async def replay(example_id: str, identity: str = Depends(owner_dependency)):
        with database() as con:
            row = con.execute("SELECT capture,label FROM examples WHERE id=? AND owner=?", (example_id, identity)).fetchone()
        if not row:
            raise HTTPException(404, "Motion recording not found")
        return {"label": row["label"], "capture": json.loads(row["capture"])}

    @api.delete("/examples/{example_id}")
    async def delete(example_id: str, identity: str = Depends(owner_dependency)):
        with database() as con:
            result = con.execute("DELETE FROM examples WHERE id=? AND owner=?", (example_id, identity))
        if not result.rowcount:
            raise HTTPException(404, "Motion recording not found")
        return {"deleted": True}

    @api.post("/predict")
    async def match(request: Request, identity: str = Depends(owner_dependency)):
        attempt = await body(request, Attempt, identity)
        try:
            sequence, meta = prepare(attempt.capture)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        # A fixed snapshot of this owner's training set; reference never affects prediction.
        with database() as con:
            rows = con.execute("SELECT id,label,features,capture FROM examples WHERE owner=?", (identity,)).fetchall()
        if any(r["capture"] == attempt.capture.model_dump_json() for r in rows):
            raise HTTPException(409, "This is a saved training take. Record fresh motion to test accuracy.")
        examples = [{"id": r["id"], "label": r["label"], "features": json.loads(r["features"])} for r in rows]
        if gate.locked():
            raise HTTPException(429, "Another motion comparison is running. Retry in a moment.")
        started = time.monotonic()
        try:
            async with gate:
                result = await asyncio.to_thread(predict, sequence, examples)
        except ValueError as exc:
            raise HTTPException(409, str(exc))
        result.update(meta, processing_s=round(time.monotonic() - started, 2))
        if words(attempt.reference):
            result["score"] = score(attempt.reference, result["text"])
            result["id"] = str(uuid.uuid4())
            result["created"] = time.time()
            with database() as con:
                con.execute("INSERT INTO tests VALUES (?, ?, ?, ?)", (result["id"], identity, result["created"], json.dumps(result)))
        return result

    return api
