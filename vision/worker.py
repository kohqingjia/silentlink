"""Isolated, restartable CPU inference process. Receives video paths, never labels."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "vendor/auto_avsr"))
MODEL_SHA256 = "fbf7cd70ff1c0e694b3030fb779dbb4570f04e4b841d62f9296c229e94878ddb"


def emit(**event):
    print(json.dumps(event), flush=True)


def load():
    import torch
    from espnet.nets.pytorch_backend.e2e_asr_conformer import E2E
    from espnet.nets.batch_beam_search import BatchBeamSearch
    from espnet.nets.scorers.length_bonus import LengthBonus
    torch.set_num_threads(int(os.environ.get("MODEL_THREADS", "3")))
    torch.set_num_interop_threads(1)
    path = Path(os.environ["MODEL_PATH"])
    emit(stage="verifying_model", message="Checking model download integrity", percent=None)
    digest = hashlib.sha256()
    size, count = path.stat().st_size, 0
    with path.open("rb") as f:
        while chunk := f.read(8 * 1024 * 1024):
            digest.update(chunk)
            count += len(chunk)
            emit(stage="verifying_model", percent=round(count * 100 / size))
    if digest.hexdigest() != MODEL_SHA256:
        raise RuntimeError("Model checksum mismatch. Administrator must replace the checkpoint.")
    emit(stage="loading_model", message="Loading the pretrained lip-reading model into memory", percent=None)
    units = ROOT / "vendor/auto_avsr/spm/unigram/unigram5000_units.txt"
    tokens = ["<blank>"] + [line.split()[0] for line in units.read_text().splitlines()] + ["<eos>"]
    model = E2E(len(tokens), "video", ctc_weight=0.1)
    model.load_state_dict(torch.load(path, map_location="cpu", weights_only=True), strict=True)
    model.eval()
    scorers = model.scorers()
    scorers.update(lm=None, length_bonus=LengthBonus(len(tokens)))
    decoder = BatchBeamSearch(beam_size=3, vocab_size=len(tokens),
                              weights={"decoder": 0.9, "ctc": 0.1, "lm": 0., "length_bonus": 0.},
                              scorers=scorers, sos=model.sos, eos=model.eos,
                              token_list=tokens, pre_beam_score_key="decoder")
    decoder.eval()
    return model, decoder, tokens


def infer(path, decode, model, decoder, tokens):
    import cv2
    import mediapipe as mp
    import numpy as np
    import torch
    from video_process import VideoProcess
    started = time.monotonic()
    emit(stage="checking_video", percent=None, message="Checking video duration and format")
    probe = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-show_streams", "-show_format", "-of", "json", path], capture_output=True, timeout=15, check=True)
    metadata = json.loads(probe.stdout)
    video = next((s for s in metadata["streams"] if s["codec_type"] == "video"), None)
    if not video or video.get("width", 0) > 1920 or video.get("height", 0) > 1920:
        raise ValueError("Use a webcam video no larger than 1920 × 1920.")
    duration = float(metadata.get("format", {}).get("duration", video.get("duration", 0)) or 0)
    if duration > 8.6:
        raise ValueError("Record a short phrase of at most 8 seconds.")
    emit(stage="decoding_video", percent=None, message="Preparing video at 25 frames per second")
    # Decode at most 8.6 s; even containers without duration cannot bypass the limit.
    raw = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i", path,
                          "-an", "-t", "8.6", "-vf", "fps=25,scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2",
                          "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], capture_output=True, timeout=25, check=True).stdout
    frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 480, 640, 3)
    if len(frames) < 10 or len(frames) > 213:
        raise ValueError("Record between half a second and 8 seconds, then try again.")
    landmarks = []
    with mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5) as detector:
        for i, frame in enumerate(frames):
            detections = detector.process(frame).detections or []
            if len(detections) > 1:
                raise ValueError("Keep only one face in the camera view.")
            if detections:
                points = detections[0].location_data.relative_keypoints
                landmarks.append(np.array([[p.x * 640, p.y * 480] for p in points[:4]]))
            else:
                landmarks.append(None)
            if i % 5 == 0 or i == len(frames) - 1:
                emit(stage="tracking_face", percent=round(100 * (i + 1) / len(frames)), message=f"Locating your face · {i + 1}/{len(frames)} frames")
    coverage = sum(x is not None for x in landmarks) / len(landmarks)
    if coverage < 0.8:
        raise ValueError("Your face was not clear in enough frames. Face the camera in brighter light and try again.")
    emit(stage="cropping_mouth", percent=None, message="Aligning and cropping the mouth region")
    patches = VideoProcess(convert_gray=False)(frames, landmarks)
    sample = torch.from_numpy(patches[:, 4:92, 4:92].copy()).float()
    sample = (sample * torch.tensor([0.2989, 0.5870, 0.1140])).sum(-1).unsqueeze(1) / 255
    sample = (sample - 0.421) / 0.165
    emit(stage="encoding", percent=None, message="Reading lip movement")
    with torch.inference_mode():
        features = model.frontend(sample.unsqueeze(0))
        # Fixed pretrained visual features, no fine-tuning claim.
        embedding = torch.cat([features.mean(1), features.std(1, unbiased=False)], -1).squeeze(0)
        embedding = torch.nn.functional.normalize(embedding, dim=0).tolist()
        text = ""
        if decode:
            projected = model.proj_encoder(features)
            hooks = []
            for index, layer in enumerate(model.encoder.encoders):
                def progress(_module, _inputs, _output, step=index + 1):
                    emit(stage="encoding", percent=round(100 * step / len(model.encoder.encoders)),
                         message=f"Reading lip movement · encoder layer {step}/{len(model.encoder.encoders)}")
                hooks.append(layer.register_forward_hook(progress))
            try:
                encoder, _ = model.encoder(projected, None)
            finally:
                for hook in hooks:
                    hook.remove()
            emit(stage="transcribing", percent=None, message="Decoding the sentence · percentage unavailable for this step")
            hypotheses = decoder(encoder.squeeze(0))
            if hypotheses:
                text = "".join(tokens[int(i)] for i in hypotheses[0].yseq[1:]).replace("▁", " ").replace("<eos>", "").replace("<blank>", "").strip()
    return {"text": text, "embedding": embedding, "duration_s": round(len(frames) / 25, 2),
            "processing_s": round(time.monotonic() - started, 2), "face_coverage_percent": round(coverage * 100),
            "model": "Auto-AVSR 3291h · beam 3 · CPU"}


if __name__ == "__main__":
    try:
        model, decoder, tokens = load()
        emit(stage="ready", percent=100, message="Lip-reading model ready")
        for line in sys.stdin:
            job = json.loads(line)
            try:
                result = infer(job["path"], job["decode"], model, decoder, tokens)
                emit(stage="complete", percent=100, result=result)
            except Exception as exc:
                # No uploaded contents, paths, labels or tokens in logs.
                message = str(exc) if isinstance(exc, ValueError) else "Video processing failed. Try a shorter, well-lit recording."
                emit(stage="failed", percent=None, error=message)
    except Exception as exc:
        emit(stage="unavailable", percent=None, message=f"Model startup failed ({type(exc).__name__}). Check server setup.")
        sys.exit(1)
