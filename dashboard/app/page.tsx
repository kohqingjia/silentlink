"use client";

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  Check,
  CircleHelp,
  Copy,
  Download,
  FlaskConical,
  Headphones,
  KeyRound,
  LoaderCircle,
  MicOff,
  Play,
  ScanFace,
  ShieldCheck,
  Square,
  Sun,
  Trash2,
  Volume2,
  Waves,
  X,
} from "lucide-react";
import s from "./camera.module.css";

type Mode = "speak" | "teach" | "test";
type Score = {
  reference: string;
  reference_words: number;
  errors: number;
  wer_percent: number;
  exact_match: boolean;
  substitutions: number;
  deletions: number;
  insertions: number;
};
type Result = {
  text: string;
  duration_s: number;
  processing_s: number;
  face_coverage_percent: number;
  model: string;
  score?: Score;
  accepted?: boolean;
  reason?: string;
  candidates?: { text: string; similarity: number; samples: number }[];
  training_ids?: string[];
};
type Job = {
  id: string;
  mode: string;
  stage: string;
  message?: string;
  error?: string;
  percent: number | null;
  elapsed_s: number;
  eta_s: number | null;
  queue_position: number;
  reference: string;
  retain: boolean;
  result?: Result;
  created: number;
};
type Status = {
  ready: boolean;
  message: string;
  stage: string;
  percent: number | null;
  queue_depth: number;
};
const done = (j: Job | null) =>
  !j || ["complete", "failed", "cancelled"].includes(j.stage);
const prompts = [
  "Please bring me a glass of water",
  "We should meet on Friday morning",
  "Can you help me open the window",
  "I would like some tea and toast",
  "She found five blue books",
  "The bright sun shines through the trees",
  "My brother works near the station",
  "Thank you for being here today",
];
const vocabulary = ["hello", "water", "help", "yes", "no", "thanks"];
const seconds = (n: number) =>
  n < 60
    ? `${Math.round(n)}s`
    : `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`;

export default function CameraWorkspace() {
  const [mode, setMode] = useState<Mode>("speak");
  const [personal, setPersonal] = useState(false);
  const [reference, setReference] = useState(prompts[0]);
  const [label, setLabel] = useState("hello");
  const [retain, setRetain] = useState(false);
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");
  const [login, setLogin] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [camera, setCamera] = useState(false);
  const [openingCamera, setOpeningCamera] = useState(false);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [recorded, setRecorded] = useState(0);
  const [upload, setUpload] = useState<number | null>(null);
  const [uploadEta, setUploadEta] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [live, setLive] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voice, setVoice] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [retry, setRetry] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(false);
  const discard = useRef(false);
  const sequence = useRef(0);
  const uploadStarted = useRef(0);
  const recordStarted = useRef(0);
  const latest = useRef({ mode, personal, reference, label, retain, token });
  const pendingBlob = useRef<Blob | null>(null);
  const recordingId = useRef("");
  const pendingSettings = useRef(latest.current);
  latest.current = { mode, personal, reference, label, retain, token };
  const busy = recording || countdown > 0 || upload !== null || !done(job);
  const training = history.filter(
    (j) => j.mode === "teach" && j.stage === "complete",
  );
  const counts = training.reduce<Record<string, number>>(
    (map, j) => ({ ...map, [j.reference]: (map[j.reference] || 0) + 1 }),
    {},
  );
  const trained = Object.values(counts).filter((n) => n >= 3).length >= 2;
  const tests = history.filter(
    (j) => j.mode === (personal ? "personal_test" : "test") && j.result?.score,
  );
  const totalWords = tests.reduce(
    (n, j) => n + j.result!.score!.reference_words,
    0,
  );
  const totalErrors = tests.reduce((n, j) => n + j.result!.score!.errors, 0);
  const exact = tests.filter((j) => j.result!.score!.exact_match).length;

  useEffect(() => {
    const saved = sessionStorage.getItem("silentlink-camera-key");
    if (saved) setToken(saved);
    const tick = setInterval(() => setClock(Date.now()), 500);
    let mounted = true;
    const refresh = () =>
      fetch("/api/vision/status", { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw Error();
          return r.json();
        })
        .then((data) => {
          if (mounted) setStatus(data);
        })
        .catch(() => {
          if (mounted)
            setStatus({
              ready: false,
              message: "Cannot reach the lip-reading service. Retrying…",
              stage: "offline",
              percent: null,
              queue_depth: 0,
            });
        });
    void refresh();
    const poll = setInterval(refresh, 5000);
    if ("speechSynthesis" in window) {
      const update = () => {
        if (mounted)
          setVoices(
            window.speechSynthesis
              .getVoices()
              .filter((v) => v.lang.startsWith("en")),
          );
      };
      update();
      window.speechSynthesis.addEventListener("voiceschanged", update);
      return () => {
        mounted = false;
        clearInterval(tick);
        clearInterval(poll);
        window.speechSynthesis.removeEventListener("voiceschanged", update);
      };
    }
    return () => {
      mounted = false;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, []);

  useEffect(
    () => () => {
      sequence.current++;
      liveRef.current = false;
      discard.current = true;
      if (timer.current) clearTimeout(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
      xhr.current?.abort();
    },
    [],
  );

  async function api(
    path: string,
    options: RequestInit = {},
    key = latest.current.token,
  ) {
    const response = await fetch(`/api/vision${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${key}`, ...options.headers },
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Error(
        data.detail || `Request failed (${response.status}). Please retry.`,
      );
    return data;
  }
  async function refreshHistory(key = latest.current.token) {
    if (!key) return;
    const data = await api("/history", {}, key);
    setHistory(data.recordings);
  }
  useEffect(() => {
    if (token) void refreshHistory(token).catch((e) => setError(e.message));
    else setHistory([]);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!job || done(job)) return;
    let cancelled = false;
    let failures = 0;
    let poll: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const next: Job = await api(`/jobs/${job!.id}`);
        if (cancelled) return;
        failures = 0;
        setJob(next);
        if (done(next)) {
          if (next.stage === "complete") {
            setRetry(false);
            pendingBlob.current = null;
            if (next.mode === "teach")
              setNotice(
                `Saved a new “${next.reference}” example. Record a different take next.`,
              );
            else setText(next.result?.text || "");
            void refreshHistory().catch((e) => setError(e.message));
            if (liveRef.current)
              timer.current = setTimeout(() => beginRecording(true), 1800);
          } else {
            liveRef.current = false;
            setLive(false);
            if (next.stage === "failed") {
              setError(next.error || "Processing failed.");
              recordingId.current = crypto.randomUUID();
              setRetry(!!pendingBlob.current);
            }
          }
          return;
        }
      } catch (e) {
        failures++;
        if (!cancelled)
          setError(
            `Connection interrupted. ${e instanceof Error ? e.message : "Reconnecting…"} Your recording may still be processing; status will retry.`,
          );
        if (failures >= 15) {
          liveRef.current = false;
          setLive(false);
        }
      }
      if (!cancelled) poll = setTimeout(read, 1500);
    }
    poll = setTimeout(read, 800);
    return () => {
      cancelled = true;
      clearTimeout(poll);
    };
  }, [job?.id, job?.stage === "cancelled"]); // Stop polling before a late response can revive a cancelled job.

  async function connect() {
    setConnecting(true);
    setError("");
    try {
      await api("/history", {}, draft.trim());
      setToken(draft.trim());
      sessionStorage.setItem("silentlink-camera-key", draft.trim());
      setDraft("");
      setLogin(false);
      setNotice("Workspace connected. You can now record and test.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setConnecting(false);
    }
  }
  async function startCamera() {
    setError("");
    setOpeningCamera(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw Error(
          "Use a current Chrome, Edge, Firefox, or Safari browser on HTTPS to record video.",
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
          setError(
            "Camera disconnected. Reconnect it and enable the camera again.",
          );
        },
        { once: true },
      );
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Camera permission was denied. Allow Camera in this site's browser permissions, then try again."
          : e instanceof Error
            ? e.message
            : "Unable to start the camera.",
      );
    } finally {
      setOpeningCamera(false);
    }
  }
  function stopCamera() {
    sequence.current++;
    discard.current = true;
    liveRef.current = false;
    setLive(false);
    setCountdown(0);
    if (timer.current) clearTimeout(timer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setCamera(false);
    setRecording(false);
  }
  function stopRecording() {
    if (timer.current) clearTimeout(timer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
  }
  async function beginRecording(isLive = false) {
    const config = latest.current;
    if (!stream.current || !config.token) {
      setLogin(!config.token);
      return;
    }
    if (
      (config.mode === "teach" && !config.label.trim()) ||
      (config.mode === "test" && !config.reference.trim())
    ) {
      setError("Enter the word or phrase before recording.");
      return;
    }
    if (config.personal && config.mode !== "teach" && !trained) {
      setError("Teach at least two words with three recordings each first.");
      return;
    }
    setError("");
    setNotice("");
    setJob(null);
    setRetry(false);
    setRecorded(0);
    pendingSettings.current = { ...config };
    recordingId.current = crypto.randomUUID();
    discard.current = false;
    const attempt = ++sequence.current;
    for (let n = isLive ? 2 : 3; n > 0; n--) {
      if (sequence.current !== attempt) return;
      setCountdown(n);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (sequence.current !== attempt || !stream.current) return;
    setCountdown(0);
    try {
      const mime = ["video/webm;codecs=vp8", "video/webm", "video/mp4"].find(
        (t) => MediaRecorder.isTypeSupported(t),
      );
      const capture = new MediaRecorder(stream.current, {
        ...(mime ? { mimeType: mime } : {}),
        videoBitsPerSecond: 1200000,
      });
      recorder.current = capture;
      const chunks: BlobPart[] = [];
      capture.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      capture.onerror = () => {
        discard.current = true;
        setError(
          "The browser could not record this video. Try Chrome or Safari and record again.",
        );
        setRecording(false);
        liveRef.current = false;
        setLive(false);
      };
      capture.onstop = () => {
        setRecording(false);
        setRecorded((Date.now() - recordStarted.current) / 1000);
        if (discard.current) return;
        const blob = new Blob(chunks, {
          type: capture.mimeType || "video/webm",
        });
        pendingBlob.current = blob;
        void send(blob, pendingSettings.current);
      };
      capture.start(250);
      recordStarted.current = Date.now();
      setRecording(true);
      timer.current = setTimeout(stopRecording, isLive ? 4000 : 8000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recording failed");
      liveRef.current = false;
      setLive(false);
    }
  }
  async function send(blob: Blob, config: typeof latest.current) {
    if (blob.size > 12 * 1024 * 1024) {
      setError("Recording exceeds 12 MB. Please record a shorter clip.");
      return;
    }
    setUpload(0);
    setUploadEta(null);
    setError("");
    uploadStarted.current = Date.now();
    const request = new XMLHttpRequest();
    xhr.current = request;
    request.open("POST", "/api/vision/jobs");
    request.timeout = 60000;
    request.setRequestHeader("X-Recording-Id", recordingId.current);
    request.setRequestHeader("Authorization", `Bearer ${config.token}`);
    request.setRequestHeader(
      "Content-Type",
      blob.type || "application/octet-stream",
    );
    request.setRequestHeader(
      "X-Recording-Mode",
      config.mode === "teach"
        ? "teach"
        : config.personal
          ? config.mode === "test"
            ? "personal_test"
            : "personal"
          : config.mode === "test"
            ? "test"
            : "transcribe",
    );
    request.setRequestHeader(
      "X-Reference-Text",
      encodeURIComponent(
        config.mode === "teach"
          ? config.label
          : config.mode === "test"
            ? config.reference
            : "",
      ),
    );
    request.setRequestHeader("X-Save-Sample", config.retain ? "yes" : "no");
    request.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setUpload(Math.round((100 * e.loaded) / e.total));
        setUploadEta(
          e.loaded
            ? (((Date.now() - uploadStarted.current) / 1000) *
                (e.total - e.loaded)) /
                e.loaded
            : null,
        );
      }
    };
    const fail = (message: string) => {
      setUpload(null);
      setError(message);
      setRetry(true);
      liveRef.current = false;
      setLive(false);
    };
    request.onload = () => {
      setUpload(null);
      let body;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        fail("The server returned an unreadable response. Please retry.");
        return;
      }
      if (request.status !== 202) {
        fail(body.detail || `Upload failed (${request.status}). Please retry.`);
        return;
      }
      setJob(body);
      setRetry(false);
    };
    request.onerror = () =>
      fail(
        "Upload interrupted. Check your connection and retry the same recording.",
      );
    request.ontimeout = () =>
      fail(
        "Upload timed out after 60 seconds. Check the connection and retry.",
      );
    request.onabort = () => {
      setUpload(null);
      setNotice("Upload cancelled.");
    };
    request.send(blob);
  }
  async function cancel() {
    sequence.current++;
    liveRef.current = false;
    setLive(false);
    setCountdown(0);
    discard.current = true;
    if (timer.current) clearTimeout(timer.current);
    stopRecording();
    xhr.current?.abort();
    if (job && !done(job)) {
      try {
        setJob(await api(`/jobs/${job.id}/cancel`, { method: "POST" }));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unable to cancel. Retry.");
      }
    }
  }
  function toggleLive() {
    if (liveRef.current) {
      void cancel();
      return;
    }
    liveRef.current = true;
    setLive(true);
    void beginRecording(true);
  }
  async function remove(id: string) {
    try {
      await api(`/jobs/${id}`, { method: "DELETE" });
      await refreshHistory();
      setNotice("Sample and any retained video deleted.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }
  function speak() {
    if (!("speechSynthesis" in window)) {
      setError(
        "This browser does not offer speech playback. You can copy the text instead.",
      );
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.voice =
      voices.find((v) => v.voiceURI === voice) || voices[0] || null;
    utterance.onerror = () =>
      setError("Voice playback failed. Try another installed voice.");
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }
  function exportResults() {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { exported_at: new Date().toISOString(), recordings: history },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "silentlink-camera-results.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  const captureSeconds = recording
    ? (clock - recordStarted.current) / 1000
    : recorded;
  const waiting = upload !== null || (job && !done(job));
  const currentProgress = upload !== null ? upload : (job?.percent ?? null);
  const currentElapsed =
    upload !== null
      ? (clock - uploadStarted.current) / 1000
      : job?.elapsed_s || 0;
  const eta = upload !== null ? uploadEta : job?.eta_s;

  return (
    <div className={s.workspace}>
      <header className={s.topbar}>
        <a className={s.brand} href="/" aria-label="SilentLink home">
          <span className={s.mark}>
            <Waves size={23} />
          </span>
          SilentLink
        </a>
        <nav className={s.toplinks} aria-label="Main navigation">
          <span className={s.phase}>PHASE 01 · CAMERA</span>
          <a href="/mesh">3D motion lab</a>
          <a href="/airpods">AirPods research</a>
          <button
            className={`${s.keyButton} ${token ? s.connected : ""}`}
            onClick={() => setLogin(true)}
          >
            <KeyRound size={15} />
            {token ? "Connected" : "Connect workspace"}
          </button>
        </nav>
      </header>
      <main className={s.main}>
        <div className={s.intro}>
          <div>
            <p className={s.eyebrow}>A SILENT SPEECH EXPERIMENT</p>
            <h1>Give your silence a voice.</h1>
            <p>
              Mouth a phrase. See what your camera understands.
              <br />
              Build your vocabulary, test it, and hear the result.
            </p>
          </div>
          <div className={s.server}>
            <span className={`${s.dot} ${status?.ready ? s.ready : ""}`} />
            {status?.ready
              ? "Lip-reading model ready"
              : status
                ? "Model preparing"
                : "Checking server…"}
          </div>
        </div>
        {error && (
          <div className={s.error} role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={17} />
            </button>
          </div>
        )}
        <div className={s.layout}>
          <div className={s.left}>
            <section className={s.panel} aria-label="Camera recording">
              <div className={s.panelHead}>
                <h2>Your camera</h2>
                <a href="/mesh" className={s.chip}>Try the 3D motion lab</a>
                <span className={s.tag}>
                  <MicOff
                    size={12}
                    style={{ display: "inline", marginRight: 5 }}
                  />
                  VIDEO ONLY
                </span>
              </div>
              <div className={s.camera}>
                <video
                  ref={video}
                  className={s.video}
                  muted
                  playsInline
                  autoPlay
                  aria-label="Mirrored webcam preview"
                  style={{ visibility: camera ? "visible" : "hidden" }}
                />
                {!camera ? (
                  <div className={s.placeholder}>
                    <ScanFace size={44} strokeWidth={1.1} />
                    <h3>It starts with a little silence.</h3>
                    <p>
                      Enable your camera and face the lens.
                      <br />
                      Your microphone stays off.
                    </p>
                    <button
                      className={`${s.button} ${s.primary}`}
                      disabled={openingCamera}
                      onClick={() => void startCamera()}
                    >
                      {openingCamera ? (
                        <LoaderCircle size={16} className={s.spinner} />
                      ) : (
                        <Camera size={16} />
                      )}{" "}
                      {openingCamera ? "Opening camera…" : "Enable camera"}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className={s.faceGuide} />
                    <div className={s.overlayTop}>
                      <span
                        className={`${s.pill} ${recording ? s.recording : ""}`}
                      >
                        {recording
                          ? `● REC ${captureSeconds.toFixed(1)}s / ${live ? 4 : 8}s`
                          : countdown
                            ? "Get ready"
                            : waiting
                              ? "Pause · processing"
                              : "Camera on · not recording"}
                      </span>
                      <button
                        className={s.pill}
                        onClick={stopCamera}
                        aria-label="Turn camera off"
                      >
                        <CameraOff size={14} />
                      </button>
                    </div>
                    <div className={s.overlayBottom}>
                      <span className={s.pill}>
                        {recording
                          ? "Mouth your phrase naturally"
                          : countdown
                            ? "Look at the camera. Keep your head still."
                            : waiting
                              ? "Wait for your result before the next phrase"
                              : "Center your face inside the guide"}
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
                    className={`${s.button} ${recording ? s.danger : s.dark}`}
                    disabled={
                      !camera ||
                      (!recording && (busy || live || !status?.ready))
                    }
                    onClick={() =>
                      recording
                        ? stopRecording()
                        : token
                          ? void beginRecording()
                          : setLogin(true)
                    }
                  >
                    {recording ? (
                      <Square size={15} fill="currentColor" />
                    ) : (
                      <Play size={15} fill="currentColor" />
                    )}
                    {recording
                      ? "Finish phrase"
                      : mode === "teach"
                        ? "Record example"
                        : mode === "test"
                          ? "Record test"
                          : "Record a phrase"}
                  </button>
                  {(countdown > 0 || waiting) && (
                    <button className={s.ghost} onClick={() => void cancel()}>
                      Cancel
                    </button>
                  )}
                </div>
                <span className={s.hint}>
                  {mode === "teach"
                    ? `“${label || "your word"}” · ${counts[label] || 0}/3+ takes`
                    : "Up to 8 seconds per phrase"}
                </span>
              </div>
              <p className={s.privacy}>
                <ShieldCheck size={14} style={{ flexShrink: 0 }} />
                {camera
                  ? "Recording sends video to your VPS for processing. Temporary clips are deleted after processing. Camera preview stays in this browser."
                  : "Camera starts only when you enable it. No microphone access is requested."}
              </p>
            </section>
            <section className={`${s.panel} ${s.learn}`}>
              <h3>A good first recording</h3>
              <div className={s.tips}>
                <div className={s.tip}>
                  <Sun size={20} />
                  <strong>Face the light</strong>Keep your whole face visible,
                  with light in front of you.
                </div>
                <div className={s.tip}>
                  <ScanFace size={20} />
                  <strong>Mouth naturally</strong>Use short phrases. Avoid
                  exaggerating each movement.
                </div>
                <div className={s.tip}>
                  <FlaskConical size={20} />
                  <strong>Test a fresh take</strong>Use a new recording to
                  measure what it learned.
                </div>
              </div>
            </section>
            <a className={`${s.panel} ${s.phaseCard}`} href="/airpods">
              <div>
                <h3>AirPods · Phase 02</h3>
                <p>Your motion research workspace is still here.</p>
              </div>
              <Headphones size={25} color="#7f9473" />
            </a>
          </div>
          <div className={s.right}>
            <section className={s.panel}>
              <div className={s.tabs} role="tablist" aria-label="Research mode">
                {(["speak", "teach", "test"] as Mode[]).map((tab) => (
                  <button
                    key={tab}
                    role="tab"
                    aria-selected={mode === tab}
                    className={`${s.tab} ${mode === tab ? s.activeTab : ""}`}
                    disabled={busy || live}
                    onClick={() => {
                      setMode(tab);
                      setNotice("");
                      setJob(null);
                      setText("");
                      setRetry(false);
                    }}
                  >
                    {tab === "speak"
                      ? "Speak"
                      : tab === "teach"
                        ? "Teach words"
                        : "Test accuracy"}
                  </button>
                ))}
              </div>
              <div className={s.body}>
                <h2>
                  {mode === "speak"
                    ? "From lips to language."
                    : mode === "teach"
                      ? "Make it personal."
                      : "See how well it works."}
                </h2>
                <p className={s.description}>
                  {mode === "speak"
                    ? "A research model reads your lip movements. Review its words before giving them a voice."
                    : mode === "teach"
                      ? "Record at least three different takes per word. Start with two or more visually distinct words."
                      : "Enter what you will mouth, then record a fresh take. The answer stays hidden from the decoder."}
                </p>
                {mode !== "teach" && (
                  <label className={s.field}>
                    <span className={s.label}>Recognition model</span>
                    <select
                      className={s.select}
                      value={personal ? "personal" : "sentence"}
                      disabled={busy || live}
                      onChange={(e) => {
                        setPersonal(e.target.value === "personal");
                        setJob(null);
                        setText("");
                      }}
                    >
                      <option value="sentence">
                        English sentences · pretrained
                      </option>
                      <option value="personal">
                        My taught vocabulary · experimental
                      </option>
                    </select>
                  </label>
                )}
                {mode === "teach" && (
                  <>
                    <label className={s.field}>
                      <span className={s.label}>
                        Word or short phrase{" "}
                        <span>{training.length}/200 samples</span>
                      </span>
                      <input
                        className={s.input}
                        value={label}
                        maxLength={80}
                        disabled={busy}
                        onChange={(e) => setLabel(e.target.value.toLowerCase())}
                        placeholder="e.g. water"
                      />
                    </label>
                    <div className={s.chips}>
                      {vocabulary.map((word) => (
                        <button
                          key={word}
                          className={`${s.chip} ${label === word ? s.chipSelected : ""}`}
                          disabled={busy}
                          onClick={() => setLabel(word)}
                        >
                          {word} {counts[word] ? `· ${counts[word]}` : ""}
                        </button>
                      ))}
                    </div>
                    <label className={s.checkbox}>
                      <input
                        type="checkbox"
                        checked={retain}
                        disabled={busy}
                        onChange={(e) => setRetain(e.target.checked)}
                      />
                      <span>
                        Also keep this video on my VPS for future research.
                        Without this, only the label and visual features are
                        saved.
                      </span>
                    </label>
                    <div className={s.note}>
                      This builds a small personal vocabulary from visual
                      examples. It does not train an entire English dictionary
                      or fine-tune the sentence model.
                    </div>
                  </>
                )}
                {mode === "test" && (
                  <>
                    <label className={s.field}>
                      <span className={s.label}>What will you mouth?</span>
                      <input
                        className={s.input}
                        value={reference}
                        maxLength={200}
                        disabled={busy}
                        onChange={(e) => setReference(e.target.value)}
                        placeholder={
                          personal
                            ? "One of your taught words"
                            : "Your test sentence"
                        }
                      />
                    </label>
                    <div className={s.chips}>
                      <button
                        className={s.chip}
                        disabled={busy}
                        onClick={() => {
                          const pool =
                            personal && Object.keys(counts).length
                              ? Object.keys(counts)
                              : prompts;
                          setReference(
                            pool[(pool.indexOf(reference) + 1) % pool.length],
                          );
                        }}
                      >
                        Next practice prompt
                      </button>
                    </div>
                  </>
                )}
                {personal && mode !== "teach" && !trained && (
                  <div className={s.note}>
                    Your vocabulary needs at least two words with three takes
                    each. Open “Teach words” to build it.
                  </div>
                )}
                {!status?.ready && (
                  <div className={s.status} role="status">
                    <div className={s.statusLine}>
                      <span>
                        <LoaderCircle
                          size={15}
                          className={s.spinner}
                          style={{ display: "inline", marginRight: 7 }}
                        />
                        {status?.message || "Checking model availability…"}
                      </span>
                      {status?.percent != null && (
                        <span>{status.percent}%</span>
                      )}
                    </div>
                    {status?.percent != null && (
                      <progress
                        className={s.progress}
                        value={status.percent}
                        max={100}
                      />
                    )}
                    <p className={s.statusMeta}>
                      Server model preparation · recording unlocks when ready
                    </p>
                  </div>
                )}
                {waiting && (
                  <div className={s.status} role="status" aria-live="polite">
                    <div className={s.statusLine}>
                      <span>
                        {upload !== null
                          ? upload === 100
                            ? "Upload complete · joining queue"
                            : "Uploading recording"
                          : job?.queue_position
                            ? `Waiting · queue position ${job.queue_position}`
                            : job?.message || "Processing recording"}
                      </span>
                      {currentProgress != null ? (
                        <span>{currentProgress}%</span>
                      ) : (
                        <LoaderCircle className={s.spinner} size={17} />
                      )}
                    </div>
                    {currentProgress != null && (
                      <progress
                        className={s.progress}
                        value={currentProgress}
                        max={100}
                        aria-label="Current stage progress"
                      />
                    )}
                    <div className={s.statusMeta}>
                      <span>{seconds(currentElapsed)} elapsed</span>
                      <span>
                        {eta != null && eta > 0
                          ? `About ${seconds(eta)} remaining · estimate`
                          : eta === 0
                            ? "Taking longer than estimated"
                            : "Estimating time from first recordings…"}
                      </span>
                    </div>
                    <p className={s.hint} style={{ marginTop: 9 }}>
                      {currentProgress == null
                        ? "This model step has no measurable percentage. Status updates automatically; a 3-minute limit prevents a stuck job."
                        : "Percentage is for the current stage."}
                    </p>
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
                {retry && (
                  <button
                    className={s.button}
                    style={{ marginTop: 14 }}
                    onClick={() =>
                      pendingBlob.current &&
                      void send(pendingBlob.current, pendingSettings.current)
                    }
                  >
                    Retry this recording
                  </button>
                )}
                {mode !== "teach" && (
                  <>
                    <div className={s.resultHead}>
                      <span>
                        {job?.stage === "complete"
                          ? "MODEL TRANSCRIPT · REVIEW BEFORE SPEAKING"
                          : "YOUR TRANSCRIPT"}
                      </span>
                      <Waves size={18} />
                    </div>
                    {job?.stage === "complete" ? (
                      <div className={s.result}>
                        <textarea
                          className={s.textarea}
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                          placeholder="No confident match. Try another recording."
                          aria-label="Editable transcript"
                        />
                        {job.result?.reason && (
                          <p className={s.hint} style={{ marginTop: 8 }}>
                            {job.result.reason}
                          </p>
                        )}
                        <div className={s.resultActions}>
                          <button
                            className={`${s.button} ${s.primary}`}
                            disabled={!text.trim()}
                            onClick={speak}
                          >
                            <Volume2 size={16} />
                            Speak text
                          </button>
                          <button
                            className={s.ghost}
                            disabled={!text}
                            onClick={() =>
                              void navigator.clipboard
                                .writeText(text)
                                .then(() => setNotice("Transcript copied."))
                                .catch(() =>
                                  setError(
                                    "Clipboard unavailable. Select and copy the text.",
                                  ),
                                )
                            }
                          >
                            <Copy size={15} />
                            Copy
                          </button>
                        </div>
                        {voices.length > 0 && (
                          <label className={s.field}>
                            <span className={s.label}>Browser voice</span>
                            <select
                              className={s.select}
                              value={voice}
                              onChange={(e) => setVoice(e.target.value)}
                            >
                              <option value="">Default English voice</option>
                              {voices.map((v) => (
                                <option key={v.voiceURI} value={v.voiceURI}>
                                  {v.name}
                                  {v.localService
                                    ? " · on device"
                                    : " · online"}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <p className={s.hint} style={{ marginTop: 10 }}>
                          Raw model output: “{job.result?.text || "no match"}” ·{" "}
                          {seconds(job.result?.processing_s || 0)} processing.
                          Editing above does not change the test score.
                        </p>
                      </div>
                    ) : (
                      <div className={s.emptyResult}>
                        Your words will appear here after processing.
                      </div>
                    )}
                  </>
                )}
                {mode === "speak" && (
                  <>
                    <div className={s.resultActions} style={{ marginTop: 21 }}>
                      <button
                        className={s.button}
                        disabled={
                          !live &&
                          (!camera ||
                            busy ||
                            !status?.ready ||
                            !token ||
                            (personal && !trained))
                        }
                        onClick={toggleLive}
                      >
                        {live ? <Square size={14} /> : <Waves size={16} />}{" "}
                        {live ? "Stop live phrases" : "Try live phrases"}
                      </button>
                      <span className={s.tag}>EXPERIMENTAL</span>
                    </div>
                    <p className={s.description}>
                      Four-second phrases, then a processing pause. Watch the
                      camera cue before mouthing the next phrase. Speech
                      playback is manual.
                    </p>
                  </>
                )}
                {mode === "test" && (
                  <>
                    <div className={s.metricGrid}>
                      <div className={s.metric}>
                        <strong>
                          {tests.length
                            ? `${Math.round((100 * exact) / tests.length)}%`
                            : "—"}
                        </strong>
                        <span>Exact phrase accuracy</span>
                      </div>
                      <div className={s.metric}>
                        <strong>
                          {totalWords
                            ? `${Math.round((100 * totalErrors) / totalWords)}%`
                            : "—"}
                        </strong>
                        <span>Word error rate ↓</span>
                      </div>
                      <div className={s.metric}>
                        <strong>{tests.length}</strong>
                        <span>Fresh test recordings</span>
                      </div>
                    </div>
                    {job?.result?.score && (
                      <div className={s.note}>
                        This take:{" "}
                        <strong>
                          {job.result.score.exact_match
                            ? "exact match"
                            : `${job.result.score.wer_percent}% word error rate`}
                        </strong>
                        . {job.result.score.substitutions} substitutions,{" "}
                        {job.result.score.deletions} missed words,{" "}
                        {job.result.score.insertions} extra words.{" "}
                        {personal && job.result.accepted === false
                          ? "Uncertain predictions count as a missed test."
                          : ""}
                      </div>
                    )}
                    <details className={s.details}>
                      <summary>How these percentages work</summary>
                      <p>
                        Exact phrase accuracy is the share of fresh tests with
                        every word correct, ignoring case and punctuation. Word
                        error rate counts substitutions, missing words, and
                        extra words divided by expected words; lower is better
                        and it can exceed 100%. These are your last 7 days of
                        results for the selected model, up to 500 records.
                        Personal tests retain the IDs of the training examples
                        used at test time.
                      </p>
                    </details>
                  </>
                )}
              </div>
            </section>
            {mode === "teach" && (
              <section className={s.panel}>
                <div className={s.panelHead}>
                  <h2>Your examples</h2>
                  <span className={s.tag}>
                    {Object.keys(counts).length} WORDS
                  </span>
                </div>
                <div className={s.body}>
                  {training.length ? (
                    <>
                      <p className={s.description}>
                        Add varied takes across sessions and lighting. Deleting
                        a sample removes it from future predictions.
                      </p>
                      <table className={s.table}>
                        <thead>
                          <tr>
                            <th>Word</th>
                            <th>Take</th>
                            <th>Saved</th>
                            <th>
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {training.slice(0, 12).map((j) => (
                            <tr key={j.id}>
                              <td>{j.reference}</td>
                              <td>{seconds(j.result?.duration_s || 0)}</td>
                              <td>
                                {j.retain ? "Video + features" : "Features"}
                              </td>
                              <td>
                                <button
                                  disabled={busy}
                                  aria-label={`Delete ${j.reference} sample`}
                                  onClick={() => void remove(j.id)}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {training.length > 12 && (
                        <p className={s.hint}>
                          Showing the latest 12 samples. Export all results
                          below.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className={s.empty}>
                      No examples yet. Choose a word above and record your first
                      take.
                    </p>
                  )}
                </div>
              </section>
            )}
            <section className={`${s.panel} ${s.learn}`}>
              <details className={s.details} style={{ marginTop: 0 }}>
                <summary>
                  <CircleHelp
                    size={15}
                    style={{ display: "inline", marginRight: 7 }}
                  />
                  Can one sentence teach every English word?
                </summary>
                <p>
                  No. Some sounds look identical on the lips, and movements
                  change with surrounding sounds. The sentence model is
                  pretrained on a large video dataset; your personal vocabulary
                  is a separate, small experiment. Varied prompts and fresh
                  tests help measure what works for you.
                </p>
                <p>
                  The model can guess plausible words even when you are not
                  speaking. Results are unverified until you check them. No
                  personal accuracy is promised. Online browser voices may send
                  the text to their voice provider.
                </p>
              </details>
            </section>
          </div>
        </div>
        <footer className={s.footer}>
          <span>
            SilentLink · Camera first. AirPods next. · Research prototype
          </span>
          <div className={s.actionsGroup}>
            {token && (
              <button onClick={exportResults} style={{ fontSize: 12 }}>
                <Download size={13} />
                Export my results
              </button>
            )}
            <a
              href="https://github.com/kohqingjia/silentlink"
              target="_blank"
              rel="noreferrer"
            >
              Source & research notes
            </a>
          </div>
        </footer>
      </main>
      {login && (
        <div
          className={s.backdrop}
          onClick={(e) => {
            if (e.target === e.currentTarget) setLogin(false);
          }}
        >
          <section
            className={s.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-title"
          >
            <h2 id="connect-title">
              {token ? "Workspace connected" : "Connect your workspace"}
            </h2>
            <p>
              {token
                ? "Your recordings and test results belong to your private workspace. The key is kept only for this browser tab's session."
                : "Use the dashboard key from your SilentLink private connection file. Camera preview works without a key; server processing needs your workspace connection."}
            </p>
            {!token && (
              <label className={s.field}>
                <span className={s.label}>Dashboard key</span>
                <input
                  autoFocus
                  type="password"
                  className={s.input}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void connect();
                    if (e.key === "Escape") setLogin(false);
                  }}
                  autoComplete="off"
                  placeholder="Paste your private dashboard key"
                />
              </label>
            )}
            {error && (
              <p role="alert" style={{ color: "#9b3d30", marginTop: 12 }}>
                {error}
              </p>
            )}
            <div className={s.modalActions}>
              <button className={s.ghost} onClick={() => setLogin(false)}>
                Close
              </button>
              {token ? (
                <button
                  className={s.button}
                  disabled={busy}
                  onClick={() => {
                    sessionStorage.removeItem("silentlink-camera-key");
                    setToken("");
                    setJob(null);
                    setText("");
                    setLogin(false);
                    stopCamera();
                  }}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  className={`${s.button} ${s.dark}`}
                  disabled={!draft.trim() || connecting}
                  onClick={() => void connect()}
                >
                  {connecting ? "Connecting…" : "Connect"}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
