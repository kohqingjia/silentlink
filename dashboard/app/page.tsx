"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  BookOpen,
  Check,
  ChevronRight,
  CircleDot,
  Database,
  FlaskConical,
  Layers3,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Plus,
  Radio,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Session = {
  id: string;
  experiment: string;
  device: string;
  started_at: string;
  notes: string;
};
type Recording = {
  id: string;
  session_id: string;
  label: string;
  recording_type: string;
  started_at: string;
  sample_count: number;
  statistics: {
    duration_s: number;
    observed_rate_hz: number;
    max_gap_s: number;
    gap_count: number;
    interruptions: number;
  };
};
type Sample = {
  t: number;
  user_acceleration: { x: number; y: number; z: number };
  rotation_rate: { x: number; y: number; z: number };
};
type FullRecording = { id: string; label: string; samples: Sample[] };
const colors = ["#17816c", "#e79244", "#637bd2"];
const date = (s: string) =>
  new Date(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

export default function Home() {
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selected, setSelected] = useState<FullRecording[]>([]);
  const [view, setView] = useState("Overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [phrase, setPhrase] = useState("");
  const [day, setDay] = useState("");
  const [device, setDevice] = useState("");
  const [kind, setKind] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [measure, setMeasure] = useState<"user_acceleration" | "rotation_rate">(
    "user_acceleration",
  );
  const [axis, setAxis] = useState<"x" | "y" | "z">("x");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<Recording | null>(null);

  useEffect(() => {
    fetch("/health")
      .then((r) => setHealthy(r.ok))
      .catch(() => setHealthy(false));
  }, []);
  async function api(path: string, options: RequestInit = {}, key = token) {
    const res = await fetch(`/api/v1/${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${key}`, ...options.headers },
      cache: "no-store",
      redirect: "error",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: "Request failed" }));
      throw new Error(
        `${res.status}: ${typeof body.detail === "string" ? body.detail : "The request could not be validated."}`,
      );
    }
    return res;
  }
  async function allPages<T>(path: string, key: string): Promise<T[]> {
    const all: T[] = [];
    for (let offset = 0; ; offset += 1000) {
      const batch = (await (
        await api(`${path}?limit=1000&offset=${offset}`, {}, key)
      ).json()) as T[];
      all.push(...batch);
      if (batch.length < 1000) return all;
    }
  }
  async function refresh(key = token) {
    setBusy(true);
    setError("");
    try {
      const [s, r] = await Promise.all([
        allPages<Session>("sessions", key),
        allPages<Recording>("recordings", key),
      ]);
      setSessions(s);
      setRecordings(r);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("me", {}, draft);
      await refresh(draft);
      setToken(draft);
      setDraft("");
      setLoginOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function disconnect() {
    setToken("");
    setSessions([]);
    setRecordings([]);
    setSelected([]);
    setError("");
    setNotice("");
  }
  async function download(path: string, name: string) {
    setBusy(true);
    setError("");
    try {
      const blob = await (await api(path)).blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function toggleRecording(r: Recording) {
    if (selected.some((s) => s.id === r.id)) {
      setSelected(selected.filter((s) => s.id !== r.id));
      return;
    }
    if (selected.length >= 3) {
      setError("Overlay up to three recordings at a time. Deselect one first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const full = await (await api(`recordings/${r.id}`)).json();
      setSelected((previous) => [...previous, full]);
      setView("Signal explorer");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      await api(`recordings/${deleting.id}`, { method: "DELETE" });
      setSelected(selected.filter((r) => r.id !== deleting.id));
      setDeleting(null);
      await refresh();
      setNotice(
        "Server recording deleted. Local exports and retained backups are separate.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = recordings.filter(
    (r) =>
      (!phrase || r.label === phrase) &&
      (!day || new Date(r.started_at).toLocaleDateString("en-CA") === day) &&
      (!device ||
        sessions.find((s) => s.id === r.session_id)?.device === device) &&
      (!kind || r.recording_type === kind) &&
      (!sessionFilter || r.session_id === sessionFilter),
  );
  const chart = useMemo(() => {
    const points = new Map<number, Record<string, number>>();
    selected.forEach((r, i) =>
      r.samples.forEach((s) => {
        const p = points.get(s.t) || { t: s.t };
        p[`r${i}`] = s[measure][axis];
        points.set(s.t, p);
      }),
    );
    return [...points.values()].sort((a, b) => a.t - b.t);
  }, [selected, measure, axis]);
  const totalSamples = recordings.reduce((n, r) => n + r.sample_count, 0);
  const totalDuration = recordings.reduce(
    (n, r) => n + r.statistics.duration_s,
    0,
  );
  const nav = [
    { title: "Overview", icon: LayoutDashboard },
    { title: "Sessions", icon: Layers3 },
    { title: "Signal explorer", icon: Activity },
    { title: "Protocol", icon: BookOpen },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-icon">
            <AudioLines size={23} />
          </span>
          silentlink<span className="brand-dot">.</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">
            <FlaskConical size={17} />
          </span>
          <div>
            Research workspace<small>AirPods motion · v0.1</small>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map(({ title, icon: Icon }) => (
            <button
              key={title}
              className={view === title ? "nav-item active" : "nav-item"}
              onClick={() => setView(title)}
            >
              <Icon size={18} />
              {title}
              {view === title && <span className="active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Radio size={21} />
          <strong>Start with the signal.</strong>
          <p>
            Measure first. Test carefully.
            <br />
            Let the data lead.
          </p>
          <span>EXPERIMENTAL PLATFORM</span>
        </div>
        <div className="sidebar-bottom">
          <span
            className={`status-dot ${healthy === false ? "offline" : ""}`}
          />
          {healthy === null
            ? "Checking service"
            : healthy
              ? "Research API online"
              : "Service unavailable"}
          <small>Motion-only milestone</small>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <div>
            Workspace <ChevronRight size={14} />
            <b>{view}</b>
          </div>
          <div className="top-actions">
            <span className="research-badge">
              <CircleDot size={12} /> RESEARCH PREVIEW
            </span>
            {token ? (
              <button
                className="text-button"
                disabled={busy}
                onClick={disconnect}
              >
                <LogOut size={15} />
                Disconnect
              </button>
            ) : (
              <button
                className="text-button"
                onClick={() => setLoginOpen(true)}
              >
                <LockKeyhole size={15} />
                Connect workspace
              </button>
            )}
          </div>
        </header>
        <nav className="mobile-nav" aria-label="Mobile workspace navigation">
          {nav.map(({ title, icon: Icon }) => (
            <button
              key={title}
              className={view === title ? "selected" : ""}
              onClick={() => setView(title)}
            >
              <Icon size={17} />
              {title}
            </button>
          ))}
        </nav>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                SILENT ARTICULATION / SENSOR FEASIBILITY
              </div>
              <h1>
                {view === "Overview"
                  ? "Your research, in motion."
                  : view === "Sessions"
                    ? "Every session tells a story."
                    : view === "Signal explorer"
                      ? "Look closer at the signal."
                      : "A question worth measuring."}
              </h1>
              <p>
                {view === "Protocol"
                  ? "A repeatable first experiment, grounded in what the sensors actually expose."
                  : "Collect real measurements. Compare sessions. Find out what’s possible."}
              </p>
            </div>
            <button
              className="button dark"
              onClick={() => {
                setView("Protocol");
                setNotice(
                  "Record on your physical iPhone using the native SilentLink app.",
                );
              }}
            >
              <Plus size={17} /> New recording
            </button>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
              <button onClick={() => setError("")} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="alert" role="status">
              {notice}
              <button onClick={() => setNotice("")} aria-label="Dismiss notice">
                <X size={16} />
              </button>
            </div>
          )}
          <div className="research-notice">
            <FlaskConical size={18} />
            <span>
              <strong>Investigation, not transcription.</strong> AirPods expose
              processed motion. Whether it contains useful silent-articulation
              information is still an open question.
            </span>
            <a
              href="https://developer.apple.com/documentation/coremotion/cmheadphonemotionmanager"
              target="_blank"
              rel="noreferrer"
            >
              API limits <ArrowRight size={14} />
            </a>
          </div>
          {view !== "Protocol" && (
            <>
              <section className="metrics" aria-label="Dataset overview">
                {[
                  {
                    label: "Recording sessions",
                    value: token
                      ? String(sessions.length).padStart(2, "0")
                      : "—",
                    detail: "Across experimental visits",
                    icon: Layers3,
                  },
                  {
                    label: "Real recordings",
                    value: token
                      ? String(recordings.length).padStart(2, "0")
                      : "—",
                    detail: "No synthetic sensor readings",
                    icon: AudioLines,
                  },
                  {
                    label: "Sensor samples",
                    value: token ? totalSamples.toLocaleString() : "—",
                    detail: `${token ? (totalDuration / 60).toFixed(1) : "—"} minutes of captured motion`,
                    icon: Database,
                  },
                  {
                    label: "Model evaluation",
                    value: "Not started",
                    detail: "Waiting for a real dataset",
                    icon: FlaskConical,
                  },
                ].map((m) => (
                  <div className="metric" key={m.label}>
                    <div>
                      {m.label}
                      <m.icon size={17} />
                    </div>
                    <strong
                      className={
                        m.label === "Model evaluation" ? "metric-text" : ""
                      }
                    >
                      {m.value}
                    </strong>
                    <small>{m.detail}</small>
                  </div>
                ))}
              </section>
              <section className="panel signal-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">SIGNAL EXPLORER</span>
                    <h2>
                      {selected.length
                        ? "Compare the recordings"
                        : "A closer look, sample by sample"}
                    </h2>
                  </div>
                  <span className="subtle-tag">
                    <span className="status-dot" /> REAL DATA ONLY
                  </span>
                </div>
                {selected.length ? (
                  <>
                    <div className="chart-toolbar">
                      <label>
                        Measurement
                        <select
                          value={measure}
                          onChange={(e) =>
                            setMeasure(e.target.value as typeof measure)
                          }
                        >
                          <option value="user_acceleration">
                            User acceleration · g
                          </option>
                          <option value="rotation_rate">
                            Angular velocity · rad/s
                          </option>
                        </select>
                      </label>
                      <label>
                        Axis
                        <select
                          value={axis}
                          onChange={(e) =>
                            setAxis(e.target.value as typeof axis)
                          }
                        >
                          <option>x</option>
                          <option>y</option>
                          <option>z</option>
                        </select>
                      </label>
                      <button
                        className="text-button"
                        onClick={() => setSelected([])}
                      >
                        Clear overlay
                      </button>
                    </div>
                    <div className="chart">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chart}>
                          <CartesianGrid
                            strokeDasharray="3 4"
                            stroke="#e4e9e5"
                          />
                          <XAxis
                            type="number"
                            dataKey="t"
                            domain={["dataMin", "dataMax"]}
                            tickFormatter={(v) => Number(v).toFixed(1)}
                            label={{
                              value: "Seconds from first sample",
                              position: "insideBottom",
                              offset: -2,
                            }}
                            height={45}
                          />
                          <YAxis
                            width={70}
                            tickFormatter={(v) => Number(v).toPrecision(2)}
                          />
                          <Tooltip
                            labelFormatter={(v) => `${Number(v).toFixed(3)} s`}
                          />
                          <Legend />
                          {selected.map((r, i) => (
                            <Line
                              key={r.id}
                              type="linear"
                              dataKey={`r${i}`}
                              name={`${r.label} · ${r.id.slice(0, 6)}`}
                              stroke={colors[i]}
                              dot={false}
                              connectNulls
                              isAnimationActive={false}
                              strokeWidth={1.5}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="chart-note">
                      Each trace is aligned to its own first sample. Lines join
                      measured samples; gaps are not reconstructed. This is a
                      visual overlay, not a synchronized capture.
                    </p>
                  </>
                ) : (
                  <div className="signal-empty">
                    <div className="empty-grid" />
                    <div className="empty-wave">
                      <AudioLines size={38} strokeWidth={1.25} />
                    </div>
                    <h3>
                      {token && recordings.length
                        ? "Choose recordings to compare"
                        : "Your first signal starts here"}
                    </h3>
                    <p>
                      {token && recordings.length
                        ? "Select up to three recordings below to overlay their measured motion."
                        : "Record a short session on your iPhone, then upload it to see the motion that was actually measured."}
                    </p>
                    <button
                      className="button"
                      onClick={() =>
                        token ? setView("Protocol") : setLoginOpen(true)
                      }
                    >
                      {token
                        ? "Read the recording protocol"
                        : "Connect your workspace"}
                      <ArrowRight size={15} />
                    </button>
                    <span>No demo data. No assumed results.</span>
                  </div>
                )}
                <div className="signal-footer">
                  <span>
                    <i className="dot green" />
                    Acceleration <small>g</small>
                  </span>
                  <span>
                    <i className="dot orange" />
                    Angular velocity <small>rad/s</small>
                  </span>
                  <span className="footer-right">
                    CMHeadphoneMotionManager <ShieldCheck size={14} />
                  </span>
                </div>
              </section>
              <section className="panel recordings-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">
                      {view === "Sessions"
                        ? "SESSION LIBRARY"
                        : "RECORDING LIBRARY"}
                    </span>
                    <h2>
                      {view === "Sessions"
                        ? "Organized by experiment"
                        : "From observation to evidence"}
                    </h2>
                  </div>
                  <div className="row">
                    <button
                      className="icon-button"
                      disabled={!token || busy}
                      onClick={() => void refresh().catch(() => {})}
                      aria-label="Refresh recordings"
                    >
                      <RefreshCw size={16} className={busy ? "spin" : ""} />
                    </button>
                    <button
                      className="button"
                      disabled={!token || busy || !recordings.length}
                      onClick={() =>
                        download(
                          `datasets/export${sessionFilter ? `?session_id=${sessionFilter}` : ""}`,
                          "silentlink-dataset.zip",
                        )
                      }
                    >
                      <ArrowDownToLine size={15} />
                      Export dataset
                    </button>
                  </div>
                </div>
                {view === "Sessions" && sessions.length > 0 && (
                  <div className="session-list">
                    {sessions.map((s) => (
                      <button
                        key={s.id}
                        className={
                          sessionFilter === s.id
                            ? "session selected"
                            : "session"
                        }
                        onClick={() =>
                          setSessionFilter(sessionFilter === s.id ? "" : s.id)
                        }
                      >
                        <Layers3 size={18} />
                        <strong>{s.experiment}</strong>
                        <span>{date(s.started_at)}</span>
                        <small>
                          {s.id.slice(0, 8)} ·{" "}
                          {
                            recordings.filter((r) => r.session_id === s.id)
                              .length
                          }{" "}
                          recordings
                        </small>
                      </button>
                    ))}
                  </div>
                )}
                <div className="filters">
                  <label>
                    Phrase
                    <select
                      value={phrase}
                      onChange={(e) => setPhrase(e.target.value)}
                    >
                      <option value="">All phrases</option>
                      {[...new Set(recordings.map((r) => r.label))].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Device
                    <select
                      value={device}
                      onChange={(e) => setDevice(e.target.value)}
                    >
                      <option value="">All devices</option>
                      {[...new Set(sessions.map((s) => s.device))].map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Type
                    <select
                      value={kind}
                      onChange={(e) => setKind(e.target.value)}
                    >
                      <option value="">All types</option>
                      <option value="motion">Motion</option>
                    </select>
                  </label>
                  <label>
                    Date
                    <input
                      type="date"
                      value={day}
                      onChange={(e) => setDay(e.target.value)}
                    />
                  </label>
                  <button
                    className="text-button"
                    onClick={() => {
                      setPhrase("");
                      setDay("");
                      setDevice("");
                      setKind("");
                      setSessionFilter("");
                    }}
                  >
                    Reset
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Recording / phrase</th>
                        <th>Session date</th>
                        <th>Samples / rate</th>
                        <th>Signal quality</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <button
                              className="record-select"
                              disabled={busy}
                              onClick={() => toggleRecording(r)}
                            >
                              {selected.some((s) => s.id === r.id) ? (
                                <Check size={16} />
                              ) : (
                                <AudioLines size={16} />
                              )}
                              <span>
                                {r.label}
                                <small>
                                  {r.id.slice(0, 8)} · {r.recording_type}
                                </small>
                              </span>
                            </button>
                          </td>
                          <td>{date(r.started_at)}</td>
                          <td>
                            {r.sample_count.toLocaleString()}
                            <small>
                              {r.statistics.observed_rate_hz.toFixed(1)} Hz
                              observed
                            </small>
                          </td>
                          <td>
                            {r.statistics.gap_count} gaps ·{" "}
                            {r.statistics.interruptions} interruptions
                            <small>
                              Max gap {r.statistics.max_gap_s.toFixed(3)} s
                            </small>
                          </td>
                          <td>
                            <div className="row">
                              <button
                                className="icon-button"
                                aria-label={`Download ${r.label} CSV`}
                                disabled={busy}
                                onClick={() =>
                                  download(
                                    `recordings/${r.id}?format=csv`,
                                    `${r.id}.csv`,
                                  )
                                }
                              >
                                <ArrowDownToLine size={16} />
                              </button>
                              <button
                                className="icon-button danger"
                                aria-label={`Delete ${r.label}`}
                                disabled={busy}
                                onClick={() => setDeleting(r)}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!filtered.length && (
                  <div className="table-empty">
                    <span className="empty-small">
                      <Layers3 size={21} />
                    </span>
                    <strong>
                      {token
                        ? "No matching recordings yet"
                        : "Your recordings are private"}
                    </strong>
                    <p>
                      {token
                        ? "Upload from the iPhone recorder or adjust your filters."
                        : "Connect with a device key to inspect your sessions and measurements."}
                    </p>
                  </div>
                )}
                <div className="table-footer">
                  {token
                    ? `${filtered.length} of ${recordings.length} recordings`
                    : "Authentication required to access research data"}
                  <span>
                    <LockKeyhole size={12} /> Protected storage
                  </span>
                </div>
              </section>
              <div className="bottom-cards">
                <button
                  className="guide-card"
                  onClick={() => setView("Protocol")}
                >
                  <span className="guide-icon">
                    <BookOpen size={21} />
                  </span>
                  <div>
                    <h3>A good experiment starts with a protocol.</h3>
                    <p>
                      Labels, negative controls, repeat sessions, and honest
                      evaluation.
                    </p>
                  </div>
                  <ArrowRight size={20} />
                </button>
                <div className="limits-card">
                  <ShieldCheck size={20} />
                  <div>
                    <h3>Local first. Always your choice.</h3>
                    <p>
                      The recorder keeps data on your iPhone until you enable
                      uploads.
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}
          {view === "Protocol" && (
            <div className="protocol-layout">
              <section className="panel protocol">
                <span className="eyebrow">MOTION-V1 / FIRST EXPERIMENT</span>
                <h2>Can we measure a useful difference?</h2>
                <p>
                  This platform collects processed headphone motion. It cannot
                  access raw speech accelerometers, individual internal
                  microphones, or H2 measurements.
                </p>
                {[
                  {
                    n: "01",
                    title: "Connect and check",
                    body: "Open the native SilentLink app on a physical iPhone. Pair AirPods normally in iOS, wear them, and check motion availability. Allow Motion & Fitness when asked. The simulator cannot validate the sensor.",
                  },
                  {
                    n: "02",
                    title: "Capture balanced classes",
                    body: "Use 15-second trials. Include rest, silently articulated phrases, normal speaking, chewing, smiling, walking, and head turning. Randomize the order and collect 10–20 repetitions per class. Record your protocol and any deviations.",
                  },
                  {
                    n: "03",
                    title: "Repeat on different days",
                    body: "Create a new session for each visit. Keep fit and posture consistent. Note movement and interruptions. Save JSON and CSV locally, then enable uploads only if you want to inspect recordings here.",
                  },
                  {
                    n: "04",
                    title: "Evaluate without leakage",
                    body: "Hold out entire sessions, including a different day. Split before windowing. Compare simple models against majority and chance baselines. Poor performance is a valid result. No prediction or LLM integration is enabled yet.",
                  },
                ].map((step) => (
                  <article className="protocol-step" key={step.n}>
                    <span>{step.n}</span>
                    <div>
                      <h3>{step.title}</h3>
                      <p>{step.body}</p>
                    </div>
                  </article>
                ))}
              </section>
              <aside className="panel protocol-aside">
                <FlaskConical size={28} />
                <h3>What remains unverified</h3>
                <p>
                  Real AirPods delivery rate, disconnect behavior, iPhone
                  permissions, and cross-session signal usefulness need
                  physical-device testing.
                </p>
                <hr />
                <h3>Audio experiment</h3>
                <p>
                  Disabled in this milestone. A later opt-in experiment must
                  record the actual audio route and evaluate Bluetooth
                  processing and latency.
                </p>
                <hr />
                <a
                  href="https://github.com/kohqingjia/silentlink"
                  target="_blank"
                  rel="noreferrer"
                >
                  Source and setup guide <ArrowRight size={15} />
                </a>
              </aside>
            </div>
          )}
          <footer className="page-footer">
            <span>
              silentlink<span className="brand-dot">.</span>{" "}
              <small>Research starts with honest measurements.</small>
            </span>
            <span>PUBLIC CODE · PRIVATE RECORDINGS</span>
          </footer>
        </main>
      </div>
      {loginOpen && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-title"
          >
            <button
              className="close"
              aria-label="Close"
              onClick={() => setLoginOpen(false)}
            >
              <X size={20} />
            </button>
            <LockKeyhole size={28} />
            <h2 id="connect-title">Connect your workspace</h2>
            <p>
              Enter the device API key issued on your VPS. It stays in memory
              for this tab and is never placed in browser storage.
            </p>
            <form onSubmit={connect}>
              <label>
                Device API key
                <input
                  autoFocus
                  type="password"
                  autoComplete="off"
                  required
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </label>
              {error && <p className="error-text">{error}</p>}
              <button className="button dark" disabled={busy}>
                {busy ? "Connecting…" : "Connect securely"}
                <ArrowRight size={16} />
              </button>
            </form>
          </section>
        </div>
      )}
      {deleting && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <h2 id="delete-title">Delete this recording?</h2>
            <p>
              Remove “{deleting.label}” from the server. This cannot be undone
              here. Local files and retained backups are separate.
            </p>
            <div className="row">
              <button
                className="button"
                onClick={() => setDeleting(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button className="button dark" onClick={remove} disabled={busy}>
                Delete recording
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
