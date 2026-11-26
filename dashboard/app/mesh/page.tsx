"use client";
import { useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  Check,
  Download,
  KeyRound,
  LoaderCircle,
  Play,
  ScanFace,
  ShieldCheck,
  Square,
  Trash2,
  Volume2,
  Waves,
  X,
} from "lucide-react";
import s from "../camera.module.css";
import m from "./mesh.module.css";
import {
  drawMesh,
  type Edge,
  type MeshCapture,
  type MeshFrame,
} from "./geometry";

type Example = {
  id: string;
  label: string;
  created: number;
  duration_s: number;
  frames: number;
  observed_fps: number;
  tracking_percent: number;
};
type Match = {
  text: string;
  accepted: boolean;
  reason: string;
  processing_s: number;
  candidates: { text: string; distance: number }[];
  score?: {
    exact_match: boolean;
    wer_percent: number;
    errors: number;
    reference_words: number;
  };
};
type Progress = { stage: string; percent: number | null; eta: number | null };
const prompts = [
  "Please bring me a glass of water",
  "Thank you for helping me today",
  "Can we meet tomorrow morning",
  "I would like a cup of tea",
  "Please turn on the lights",
  "I need a little more time",
];
const rounded = (values: number[]) =>
  values.map((n) => Math.round(n * 100000) / 100000);

export default function MeshLab() {
  const [token, setToken] = useState("");
  const [key, setKey] = useState("");
  const [login, setLogin] = useState(false);
  const [camera, setCamera] = useState(false);
  const [ready, setReady] = useState(false);
  const [faces, setFaces] = useState(0);
  const [overlay, setOverlay] = useState(true);
  const [angle, setAngle] = useState(0);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [capture, setCapture] = useState<MeshCapture | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [replayTime, setReplayTime] = useState(0);
  const [label, setLabel] = useState(prompts[0]);
  const [mode, setMode] = useState<"teach" | "test">("teach");
  const [examples, setExamples] = useState<Example[]>([]);
  const [tests, setTests] = useState<Match[]>([]);
  const [match, setMatch] = useState<Match | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestElapsed, setRequestElapsed] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const worker = useRef<Worker | null>(null);
  const raf = useRef(0);
  const inFlight = useRef(false);
  const lastSend = useRef(0);
  const lastVideoTime = useRef(-1);
  const lastUI = useRef(0);
  const captureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingStart = useRef<number | null>(null);
  const recordedFrames = useRef<MeshFrame[]>([]);
  const recordingID = useRef("");
  const currentFrame = useRef<MeshFrame | null>(null);
  const dimensions = useRef({ width: 640, height: 480 });
  const edges = useRef<Edge[]>([]);
  const lips = useRef<Edge[]>([]);
  const view = useRef({ overlay, angle, replaying });
  const sequence = useRef(0);
  const request = useRef<XMLHttpRequest | null>(null);
  const libraryRequest = useRef<AbortController | null>(null);
  const initTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureRef = useRef<MeshCapture | null>(null);
  const replayStart = useRef(0);
  view.current = { overlay, angle, replaying };
  captureRef.current = capture;
  const counts = examples.reduce<Record<string, number>>(
    (out, e) => ({ ...out, [e.label]: (out[e.label] || 0) + 1 }),
    {},
  );
  const trained = Object.values(counts).filter((n) => n >= 3).length >= 2;
  const exact = tests.filter((t) => t.score?.exact_match).length;
  const totalWords = tests.reduce(
      (n, t) => n + (t.score?.reference_words || 0),
      0,
    ),
    errors = tests.reduce((n, t) => n + (t.score?.errors || 0), 0);

  useEffect(() => {
    void fetch("/mediapipe/1.2.3/topology.json")
      .then((r) => r.json())
      .then((data) => {
        edges.current = data.edges;
        lips.current = data.lips;
      })
      .catch(() => {});
    const saved = sessionStorage.getItem("silentlink-camera-key");
    if (saved) setToken(saved);
    return () => {
      sequence.current++;
      stopResources();
      request.current?.abort();
      libraryRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (token) void refresh(token).catch((e) => setError(e.message));
    else {
      setExamples([]);
      setTests([]);
    }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (canvas.current)
      drawMesh(
        canvas.current,
        currentFrame.current,
        edges.current,
        lips.current,
        overlay && !replaying,
        angle,
        dimensions.current.width / dimensions.current.height,
      );
  }, [overlay, angle, replaying]);
  useEffect(() => {
    if (!replaying || !capture) return;
    let frameID = 0;
    replayStart.current = performance.now();
    setOverlay(false);
    const animate = () => {
      const duration =
        capture.frames[capture.frames.length - 1].t - capture.frames[0].t;
      const t =
        (performance.now() - replayStart.current) % Math.max(1, duration);
      const frame =
        capture.frames.findLast((f) => f.t <= t + capture.frames[0].t) ||
        capture.frames[0];
      currentFrame.current = frame;
      if (canvas.current)
        drawMesh(
          canvas.current,
          frame,
          edges.current,
          lips.current,
          false,
          view.current.angle,
          capture.width / capture.height,
        );
      setReplayTime(t / 1000);
      frameID = requestAnimationFrame(animate);
    };
    frameID = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameID);
  }, [replaying, capture]);
  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    const id = setInterval(
      () => setRequestElapsed((Date.now() - start) / 1000),
      500,
    );
    return () => clearInterval(id);
  }, [busy]);

  async function api(path: string, options: RequestInit = {}, secret = token) {
    const r = await fetch(`/api/vision/mesh${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${secret}`, ...options.headers },
      cache: "no-store",
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(data.detail || "Request failed. Please retry.");
    return data;
  }
  async function refresh(secret = token) {
    const data = await api("/library", {}, secret);
    setExamples(data.examples);
    setTests(data.tests);
  }
  async function connect() {
    setError("");
    setBusy(true);
    try {
      await refresh(key.trim());
      setToken(key.trim());
      sessionStorage.setItem("silentlink-camera-key", key.trim());
      setKey("");
      setLogin(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  }
  function stopResources() {
    if (captureTimer.current) clearTimeout(captureTimer.current);
    cancelAnimationFrame(raf.current);
    worker.current?.terminate();
    worker.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    inFlight.current = false;
    if (initTimer.current) clearTimeout(initTimer.current);
  }
  function stopCamera() {
    sequence.current++;
    recordingStart.current = null;
    stopResources();
    setCamera(false);
    setReady(false);
    setRecording(false);
    setCountdown(0);
    setProgress(null);
    setFaces(0);
    if (video.current) video.current.srcObject = null;
  }
  function render() {
    if (canvas.current && !view.current.replaying)
      drawMesh(
        canvas.current,
        currentFrame.current,
        edges.current,
        lips.current,
        view.current.overlay,
        view.current.angle,
        dimensions.current.width / dimensions.current.height,
      );
  }
  async function startCamera() {
    setError("");
    setNotice("");
    setReplaying(false);
    setProgress({
      stage: "Opening camera and loading tracking software",
      percent: null,
      eta: null,
    });
    const attempt = ++sequence.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.Worker)
        throw Error(
          "Use a current desktop browser with camera and WebAssembly support.",
        );
      const media = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 25, max: 30 },
          facingMode: "user",
        },
        audio: false,
      });
      if (sequence.current !== attempt) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = media;
      setCamera(true);
      if (video.current) {
        video.current.srcObject = media;
        await video.current.play();
      }
      media.getVideoTracks()[0].addEventListener(
        "ended",
        () => {
          stopCamera();
          setError("Camera disconnected. Enable it again to continue.");
        },
        { once: true },
      );
      const tracker = new Worker("/mesh-worker.js", { type: "module" });
      worker.current = tracker;
      initTimer.current = setTimeout(() => {
        stopCamera();
        setError(
          "Tracker startup exceeded 90 seconds. Retry the camera when your connection is stable.",
        );
      }, 90000);
      tracker.onerror = () => {
        stopCamera();
        setError(
          "Face tracking could not start. Retry in a current Chrome, Edge or Firefox browser.",
        );
      };
      tracker.onmessage = ({ data }) => {
        if (worker.current !== tracker) return;
        if (data.type === "progress") setProgress(data);
        if (data.type === "error") {
          stopCamera();
          setError(data.message);
        }
        if (data.type === "ready") {
          if (initTimer.current) clearTimeout(initTimer.current);
          edges.current = data.edges;
          lips.current = data.lips;
          setReady(true);
          setProgress(null);
          const loop = async (now: number) => {
            if (worker.current !== tracker) return;
            raf.current = requestAnimationFrame(loop);
            const v = video.current;
            if (inFlight.current && now - lastSend.current > 5000) {
              stopCamera();
              setError(
                "Face tracking stopped responding. Restart the camera to retry.",
              );
              return;
            }
            if (
              !v ||
              v.readyState < 2 ||
              inFlight.current ||
              now - lastSend.current < 40 ||
              v.currentTime === lastVideoTime.current ||
              view.current.replaying
            )
              return;
            lastSend.current = now;
            lastVideoTime.current = v.currentTime;
            inFlight.current = true;
            try {
              const bitmap = await createImageBitmap(v);
              if (worker.current !== tracker) {
                bitmap.close();
                return;
              }
              tracker.postMessage(
                {
                  type: "frame",
                  bitmap,
                  timestamp: now,
                  width: v.videoWidth,
                  height: v.videoHeight,
                },
                [bitmap],
              );
            } catch {
              inFlight.current = false;
            }
          };
          raf.current = requestAnimationFrame(loop);
        }
        if (data.type === "frame") {
          inFlight.current = false;
          dimensions.current = { width: data.width, height: data.height };
          const frame: MeshFrame = {
            t: data.timestamp,
            faces: data.faces,
            xyz: data.xyz,
            pose: data.pose,
          };
          currentFrame.current = frame;
          render();
          if (data.timestamp - lastUI.current > 200) {
            setFaces(data.faces);
            lastUI.current = data.timestamp;
          }
          if (
            recordingStart.current !== null &&
            data.timestamp >= recordingStart.current
          ) {
            const t = data.timestamp - recordingStart.current;
            if (t <= 8000 && recordedFrames.current.length < 210)
              recordedFrames.current.push({
                t: Math.round(t),
                faces: data.faces,
                xyz: data.faces === 1 ? rounded(data.xyz) : [],
                pose: data.faces === 1 ? rounded(data.pose) : [],
              });
            setElapsed(t / 1000);
            if (t >= 8000) finishRecording();
          }
        }
      };
      tracker.postMessage({ type: "init" });
    } catch (e) {
      stopCamera();
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Allow Camera in your browser's site permissions, then retry."
          : e instanceof Error
            ? e.message
            : "Camera unavailable",
      );
    }
  }
  async function beginRecording() {
    if (!label.trim()) {
      setError("Enter the sentence you will mouth first.");
      return;
    }
    setReplaying(false);
    setMatch(null);
    setCapture(null);
    setError("");
    setNotice("");
    setElapsed(0);
    recordedFrames.current = [];
    recordingID.current = crypto.randomUUID();
    const attempt = ++sequence.current;
    for (let n = 3; n > 0; n--) {
      if (sequence.current !== attempt) return;
      setCountdown(n);
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (sequence.current !== attempt) return;
    setCountdown(0);
    recordingStart.current = performance.now();
    setRecording(true);
    captureTimer.current = setTimeout(finishRecording, 8000);
  }
  function finishRecording() {
    if (recordingStart.current === null) return;
    if (captureTimer.current) clearTimeout(captureTimer.current);
    recordingStart.current = null;
    setRecording(false);
    const frames = recordedFrames.current;
    if (frames.length < 10) {
      setError(
        "Not enough tracked frames. Keep your face visible and record a longer take.",
      );
      return;
    }
    setCapture({
      schema_version: "mediapipe-478-v1",
      ...dimensions.current,
      frames: [...frames],
    });
    setNotice(
      "Motion captured in this tab. Review it before saving or testing. No video was recorded.",
    );
  }
  function cancelRecording() {
    if (captureTimer.current) clearTimeout(captureTimer.current);
    sequence.current++;
    recordingStart.current = null;
    recordedFrames.current = [];
    setRecording(false);
    setCountdown(0);
    setNotice("Recording cancelled; motion was discarded.");
  }
  async function submit(kind: "save" | "test") {
    if (!token) {
      setLogin(true);
      return;
    }
    if (!capture) return;
    setBusy(true);
    setError("");
    setNotice("");
    setRequestElapsed(0);
    setProgress({ stage: "Uploading motion points", percent: 0, eta: null });
    const payload =
      kind === "save"
        ? { id: recordingID.current, label, capture }
        : { reference: label, capture };
    const xhr = new XMLHttpRequest();
    request.current = xhr;
    xhr.open(
      "POST",
      `/api/vision/mesh/${kind === "save" ? "examples" : "predict"}`,
    );
    xhr.timeout = 45000;
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/json");
    const start = Date.now();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        setProgress({
          stage:
            e.loaded === e.total
              ? kind === "save"
                ? "Checking and saving motion"
                : "Comparing with your taught phrases"
              : "Uploading motion points",
          percent: Math.round((100 * e.loaded) / e.total),
          eta: e.loaded
            ? Math.round(
                (((Date.now() - start) / 1000) * (e.total - e.loaded)) /
                  e.loaded,
              )
            : null,
        });
    };
    xhr.onload = () => {
      setBusy(false);
      setProgress(null);
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        setError("Unreadable server response. Retry this capture.");
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        setError(
          data.detail || "Motion processing failed. Retry this capture.",
        );
        return;
      }
      if (kind === "save")
        setNotice(
          `Saved “${data.label}” as movement data. Future phrase comparisons will include it.`,
        );
      else setMatch(data);
      void refresh().catch((e) => setError(e.message));
    };
    xhr.onerror = () => {
      setBusy(false);
      setProgress(null);
      setError(
        "Connection interrupted. Your capture is still in this tab; retry it.",
      );
    };
    xhr.ontimeout = () => {
      setBusy(false);
      setProgress(null);
      setError(
        "Request exceeded 45 seconds. Retry the capture; saved examples use an ID to prevent duplicates.",
      );
    };
    xhr.onabort = () => {
      setBusy(false);
      setProgress(null);
      setNotice(
        "Request cancelled. A save already accepted by the server may appear in your library.",
      );
      void refresh().catch(() => {});
    };
    xhr.send(JSON.stringify(payload));
  }
  async function loadExample(id: string) {
    const controller = new AbortController();
    libraryRequest.current = controller;
    setBusy(true);
    setRequestElapsed(0);
    setProgress({ stage: "Loading saved motion", percent: null, eta: null });
    try {
      const data = await api(`/examples/${id}`, {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
      });
      setCapture(data.capture);
      setLabel(data.label);
      recordingID.current = id;
      setReplaying(true);
      setMatch(null);
      setNotice(
        "Replaying a saved training example. Record a fresh take to test accuracy.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Replay failed");
    } finally {
      libraryRequest.current = null;
      setBusy(false);
      setProgress(null);
    }
  }
  async function remove(id: string) {
    try {
      await api(`/examples/${id}`, { method: "DELETE" });
      await refresh();
      setNotice(
        "Saved motion deleted. It will not be used in future comparisons.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }
  function download() {
    if (!capture) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ label, capture })], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "silentlink-face-motion.json";
    link.click();
    URL.revokeObjectURL(url);
  }
  function speak() {
    if (!match?.text || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(match.text));
  }
  const savedCapture = examples.some((e) => e.id === recordingID.current);
  const locked = recording || countdown > 0 || busy;

  return (
    <div className={s.workspace}>
      <header className={s.topbar}>
        <a className={s.brand} href="/">
          <span className={s.mark}>
            <Waves size={23} />
          </span>
          SilentLink
        </a>
        <nav className={s.toplinks}>
          <span className={s.phase}>3D MOTION LAB</span>
          <a href="/">English video model</a>
          <button className={s.keyButton} onClick={() => setLogin(true)}>
            <KeyRound size={15} />
            {token ? "Connected" : "Connect workspace"}
          </button>
        </nav>
      </header>
      <main className={s.main}>
        <div className={s.intro}>
          <div>
            <p className={s.eyebrow}>YOUR MOVEMENT, POINT BY POINT</p>
            <h1>A face in motion.</h1>
            <p>
              A live mesh follows your lips, jaw and face. Save the movement.
              <br />
              Your video stays on your device in this lab.
            </p>
          </div>
          <span className={s.phase}>478 ESTIMATED 3D POINTS</span>
        </div>
        {error && (
          <div className={s.error} role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        <div className={s.layout}>
          <div className={s.left}>
            <section className={s.panel}>
              <div className={s.panelHead}>
                <h2>
                  {replaying ? "Saved motion replay" : "Live face tracking"}
                </h2>
                <span className={s.tag}>NO VIDEO UPLOAD</span>
              </div>
              <div className={`${s.camera} ${m.camera}`}>
                <video
                  ref={video}
                  className={s.video}
                  muted
                  autoPlay
                  playsInline
                  style={{
                    visibility:
                      camera && overlay && !replaying ? "visible" : "hidden",
                  }}
                  aria-label="Local webcam preview"
                />
                <canvas
                  ref={canvas}
                  width={640}
                  height={480}
                  className={m.canvas}
                  style={{
                    visibility: camera || capture ? "visible" : "hidden",
                  }}
                  aria-label="Live estimated 3D face mesh"
                />
                {!camera && !capture && (
                  <div className={s.placeholder}>
                    <ScanFace size={48} />
                    <h3>Meet your moving mesh.</h3>
                    <p>
                      Real face tracking on your device.
                      <br />
                      No microphone. No recorded video.
                    </p>
                    <button
                      className={`${s.button} ${s.primary}`}
                      disabled={!!progress}
                      onClick={() => void startCamera()}
                    >
                      <Camera size={16} />
                      Enable camera & mesh
                    </button>
                  </div>
                )}
                {(camera || capture) && (
                  <>
                    <div className={s.overlayTop}>
                      <span
                        className={`${s.pill} ${recording ? s.recording : ""}`}
                      >
                        {recording
                          ? `● MOTION ${elapsed.toFixed(1)}s / 8s`
                          : replaying
                            ? `REPLAY ${replayTime.toFixed(1)}s`
                            : !ready
                              ? "Preparing tracker…"
                              : faces === 1
                                ? "Face tracked · 478 points"
                                : faces > 1
                                  ? "Keep one face in view"
                                  : "Looking for your face"}
                      </span>
                      {camera && (
                        <button
                          className={s.pill}
                          aria-label="Turn camera off"
                          onClick={stopCamera}
                        >
                          <CameraOff size={16} />
                        </button>
                      )}
                    </div>
                    <div className={s.overlayBottom}>
                      <span className={s.pill}>
                        {recording
                          ? label
                          : replaying
                            ? "Reconstructed from coordinates only"
                            : "Estimated depth · green lines track your lips"}
                      </span>
                    </div>
                  </>
                )}
                {countdown > 0 && (
                  <div className={s.countdown} role="status">
                    {countdown}
                  </div>
                )}
              </div>
              <div className={s.cameraActions}>
                <div className={s.actionsGroup}>
                  <button
                    className={`${s.button} ${s.dark}`}
                    disabled={
                      !camera ||
                      !ready ||
                      (!recording && (locked || faces !== 1))
                    }
                    onClick={() =>
                      recording ? finishRecording() : void beginRecording()
                    }
                  >
                    {recording ? <Square size={15} /> : <Play size={15} />}{" "}
                    {recording ? "Finish motion" : "Record sentence"}
                  </button>
                  {(recording || countdown > 0) && (
                    <button className={s.ghost} onClick={cancelRecording}>
                      Cancel
                    </button>
                  )}
                  {!camera && capture && (
                    <button
                      className={s.button}
                      disabled={!!progress}
                      onClick={() => void startCamera()}
                    >
                      Restart camera
                    </button>
                  )}
                </div>
                <div className={s.actionsGroup}>
                  <button
                    className={s.chip}
                    aria-pressed={overlay && !replaying}
                    disabled={replaying}
                    onClick={() => {
                      setOverlay(true);
                      setAngle(0);
                    }}
                  >
                    Camera + mesh
                  </button>
                  <button
                    className={s.chip}
                    aria-pressed={!overlay || replaying}
                    onClick={() => setOverlay(false)}
                  >
                    Mesh only
                  </button>
                </div>
              </div>
              {(!overlay || replaying) && (
                <label className={m.rotation}>
                  Rotate mesh view{" "}
                  <input
                    type="range"
                    min={-55}
                    max={55}
                    value={angle}
                    onChange={(e) => setAngle(Number(e.target.value))}
                  />{" "}
                  {angle}°
                </label>
              )}
              <p className={s.privacy}>
                <ShieldCheck size={14} />
                Only numbered coordinates, head pose and timestamps are uploaded
                when you save or test. This is still personal facial data, not
                anonymous data.
              </p>
            </section>
            <section className={`${s.panel} ${s.learn}`}>
              <h3>There is real tracking behind the wireframe.</h3>
              <p className={s.description}>
                The lines join points estimated from each camera frame. Saved
                motion can animate the face again without a video. Depth is
                inferred from a single webcam; it is not a measured scan or a
                complete head model.
              </p>
              <p className={s.description}>
                The phrase matcher compares the order and shape of your lip
                movements. A new corrected example joins future comparisons. No
                result is silently used as its own training label.
              </p>
            </section>
          </div>
          <div className={s.right}>
            <section className={s.panel}>
              <div
                className={s.tabs}
                style={{ gridTemplateColumns: "1fr 1fr" }}
                role="tablist"
                aria-label="Motion mode"
              >
                {(["teach", "test"] as const).map((tab) => (
                  <button
                    key={tab}
                    className={`${s.tab} ${mode === tab ? s.activeTab : ""}`}
                    role="tab"
                    aria-selected={mode === tab}
                    disabled={locked}
                    onClick={() => {
                      setMode(tab);
                      setMatch(null);
                      setNotice("");
                      setCapture(null);
                      setReplaying(false);
                    }}
                  >
                    {tab === "teach" ? "Teach sentences" : "Test fresh motion"}
                  </button>
                ))}
              </div>
              <div className={s.body}>
                <h2>
                  {mode === "teach"
                    ? "Teach a whole phrase."
                    : "Put your motion to the test."}
                </h2>
                <p className={s.description}>
                  {mode === "teach"
                    ? "Record the sentence you actually mouth. Save three separate takes of at least two phrases to begin matching."
                    : "Record a new take. Your expected sentence is used only to score the result after recognition."}
                </p>
                <label className={s.field}>
                  <span className={s.label}>
                    {mode === "teach"
                      ? "Sentence to teach"
                      : "Expected sentence"}
                  </span>
                  <textarea
                    className={s.input}
                    rows={2}
                    maxLength={200}
                    value={label}
                    disabled={locked || savedCapture}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
                <div className={s.chips}>
                  <button
                    className={s.chip}
                    disabled={locked || savedCapture}
                    onClick={() =>
                      setLabel(
                        prompts[(prompts.indexOf(label) + 1) % prompts.length],
                      )
                    }
                  >
                    Next sentence
                  </button>
                  <span className={s.hint}>Natural pace · up to 8 seconds</span>
                </div>
                {progress && (
                  <div className={s.status} role="status">
                    <div className={s.statusLine}>
                      <span>{progress.stage}</span>
                      {progress.percent !== null ? (
                        <span>{progress.percent}%</span>
                      ) : (
                        <LoaderCircle size={17} className={s.spinner} />
                      )}
                    </div>
                    {progress.percent !== null && (
                      <progress
                        className={s.progress}
                        value={progress.percent}
                        max={100}
                      />
                    )}
                    <div className={s.statusMeta}>
                      <span>
                        {busy
                          ? `${Math.round(requestElapsed)}s elapsed`
                          : "One-time tracker download on this device"}
                      </span>
                      <span>
                        {progress.eta
                          ? `About ${progress.eta}s remaining`
                          : progress.percent === 100
                            ? "Upload complete · finishing on server"
                            : "Estimating…"}
                      </span>
                    </div>
                    {busy ? (
                      <button
                        className={s.ghost}
                        onClick={() => {
                          if (libraryRequest.current)
                            libraryRequest.current.abort();
                          else request.current?.abort();
                        }}
                      >
                        Cancel request
                      </button>
                    ) : (
                      <button className={s.ghost} onClick={stopCamera}>
                        Cancel loading
                      </button>
                    )}
                  </div>
                )}
                {notice && (
                  <p className={s.note} role="status">
                    <Check
                      size={14}
                      style={{ display: "inline", marginRight: 5 }}
                    />
                    {notice}
                  </p>
                )}
                {capture && (
                  <div className={m.capture}>
                    <div className={s.label}>
                      Your motion capture{" "}
                      <span>
                        {capture.frames.length} frames ·{" "}
                        {Math.round(
                          new Blob([JSON.stringify(capture)]).size / 1024,
                        )}{" "}
                        KB
                      </span>
                    </div>
                    <div className={s.actionsGroup} style={{ marginTop: 12 }}>
                      <button
                        className={s.button}
                        disabled={locked || !edges.current.length}
                        onClick={() => setReplaying((v) => !v)}
                      >
                        {replaying ? <Square size={14} /> : <Play size={14} />}{" "}
                        {replaying ? "Stop replay" : "Replay mesh"}
                      </button>
                      <button
                        className={s.ghost}
                        disabled={busy}
                        onClick={download}
                      >
                        <Download size={14} />
                        Download points
                      </button>
                    </div>
                    <button
                      className={`${s.button} ${s.primary}`}
                      style={{ marginTop: 14, width: "100%" }}
                      disabled={
                        locked || savedCapture || (mode === "test" && !trained)
                      }
                      onClick={() =>
                        void submit(mode === "teach" ? "save" : "test")
                      }
                    >
                      {savedCapture
                        ? "Saved training take · record a fresh test"
                        : mode === "teach"
                          ? "Save sentence motion"
                          : "Test this fresh take"}
                    </button>
                  </div>
                )}
                {mode === "test" && !trained && (
                  <p className={s.note}>
                    First save three takes each of two different phrases in
                    Teach sentences.
                  </p>
                )}
                {match && (
                  <div className={s.status}>
                    <span className={s.label}>PERSONAL PHRASE MATCH</span>
                    <p className={m.transcript}>
                      {match.text || "Not sure yet"}
                    </p>
                    <p className={s.description}>
                      {match.reason} · {match.processing_s}s processing
                    </p>
                    {match.score && (
                      <p className={s.note}>
                        {match.score.exact_match
                          ? "Exact match"
                          : `${match.score.wer_percent}% word error rate`}
                        . This result uses your fresh recording, not a saved
                        training take.
                      </p>
                    )}
                    {!savedCapture && (
                      <button
                        className={s.button}
                        disabled={locked}
                        onClick={() => void submit("save")}
                      >
                        Save my confirmed sentence as an example
                      </button>
                    )}
                    {match.text && (
                      <button className={s.button} onClick={speak}>
                        <Volume2 size={16} />
                        Speak phrase
                      </button>
                    )}
                    <details className={s.details}>
                      <summary>Closest phrases</summary>
                      {match.candidates.map((c) => (
                        <p key={c.text}>
                          {c.text} · distance {c.distance.toFixed(3)}
                        </p>
                      ))}
                      <p>
                        Lower distance means closer motion. It is not a
                        confidence percentage; rejection thresholds are
                        experimental.
                      </p>
                    </details>
                  </div>
                )}
                <div className={s.metricGrid}>
                  <div className={s.metric}>
                    <strong>{examples.length}</strong>
                    <span>Saved motion takes</span>
                  </div>
                  <div className={s.metric}>
                    <strong>
                      {tests.length
                        ? `${Math.round((exact * 100) / tests.length)}%`
                        : "—"}
                    </strong>
                    <span>Exact phrase accuracy</span>
                  </div>
                  <div className={s.metric}>
                    <strong>
                      {totalWords
                        ? `${Math.round((errors * 100) / totalWords)}%`
                        : "—"}
                    </strong>
                    <span>Word error rate ↓</span>
                  </div>
                </div>
                <p className={s.note}>
                  This experiment recognizes phrases you have taught. It does
                  not yet learn to compose unseen English sentences from mesh
                  data. The{" "}
                  <a href="/" style={{ textDecoration: "underline" }}>
                    English model
                  </a>{" "}
                  uses temporary mouth video instead.
                </p>
              </div>
            </section>
            <section className={s.panel}>
              <div className={s.panelHead}>
                <h2>Your motion library</h2>
                <span className={s.tag}>{examples.length}/200 TAKES</span>
              </div>
              <div className={s.body}>
                {examples.length ? (
                  <div className={m.library}>
                    {examples.map((e) => (
                      <div className={m.example} key={e.id}>
                        <div>
                          <strong>{e.label}</strong>
                          <p>
                            {e.duration_s}s · {e.frames} frames ·{" "}
                            {counts[e.label]} takes for this phrase
                          </p>
                        </div>
                        <div className={s.actionsGroup}>
                          <button
                            className={s.ghost}
                            disabled={locked}
                            aria-label={`Replay ${e.label}`}
                            onClick={() => void loadExample(e.id)}
                          >
                            <Play size={16} />
                          </button>
                          <button
                            className={s.ghost}
                            disabled={locked}
                            aria-label={`Delete ${e.label}`}
                            onClick={() => void remove(e.id)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={s.empty}>
                    No saved motion yet. Your camera preview is never saved
                    automatically.
                  </p>
                )}
              </div>
            </section>
          </div>
        </div>
        <footer className={s.footer}>
          <span>
            Personal motion stays in your workspace. Delete examples anytime;
            older backups expire after 14 days.
          </span>
          <a href="https://github.com/kohqingjia/silentlink">
            Source & research notes
          </a>
        </footer>
      </main>
      {login && (
        <div className={s.backdrop}>
          <section
            className={s.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mesh-connect"
          >
            <h2 id="mesh-connect">
              {token ? "Workspace connected" : "Connect your workspace"}
            </h2>
            <p>
              Use your existing dashboard key. Preview and capture work locally;
              saving and comparing motion use your private VPS workspace.
            </p>
            {!token && (
              <label className={s.field}>
                <span className={s.label}>Dashboard key</span>
                <input
                  autoFocus
                  className={s.input}
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="off"
                />
              </label>
            )}
            {error && <p role="alert">{error}</p>}
            <div className={s.modalActions}>
              <button className={s.ghost} onClick={() => setLogin(false)}>
                Close
              </button>
              {token ? (
                <button
                  className={s.button}
                  disabled={locked}
                  onClick={() => {
                    setToken("");
                    sessionStorage.removeItem("silentlink-camera-key");
                    setLogin(false);
                    stopCamera();
                    setCapture(null);
                    setReplaying(false);
                  }}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  className={`${s.button} ${s.dark}`}
                  disabled={!key.trim() || busy}
                  onClick={() => void connect()}
                >
                  Connect
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
