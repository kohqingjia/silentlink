export type MeshFrame = {
  t: number;
  faces: number;
  xyz: number[];
  pose: number[];
};
export type MeshCapture = {
  schema_version: "mediapipe-478-v1";
  width: number;
  height: number;
  frames: MeshFrame[];
};
export type Edge = { start: number; end: number };

/** Draw actual estimated XYZ coordinates; rotation affects display only. */
export function drawMesh(
  canvas: HTMLCanvasElement,
  frame: MeshFrame | null,
  edges: Edge[],
  lips: Edge[],
  overlay: boolean,
  angle: number,
  aspect: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const targetHeight = Math.round(canvas.width / aspect);
  if (canvas.height !== targetHeight) canvas.height = targetHeight;
  const w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!overlay) {
    ctx.fillStyle = "#091520";
    ctx.fillRect(0, 0, w, h);
  }
  if (!frame?.xyz.length) return;
  const points = frame.xyz;
  const center = [0, 0, 0];
  for (let i = 0; i < points.length; i += 3) {
    center[0] += points[i];
    center[1] += points[i + 1];
    center[2] += points[i + 2];
  }
  center.forEach((_, i) => (center[i] /= points.length / 3));
  const ys = points.filter((_, i) => i % 3 === 1);
  const zoom = Math.min(
    4,
    0.72 / Math.max(0.18, Math.max(...ys) - Math.min(...ys)),
  );
  const rotation = (angle * Math.PI) / 180;
  const project = (i: number) => {
    if (overlay) return [(1 - points[i * 3]) * w, points[i * 3 + 1] * h];
    const x = (points[i * 3] - center[0]) * aspect,
      y = points[i * 3 + 1] - center[1],
      z = (points[i * 3 + 2] - center[2]) * aspect;
    const xr = x * Math.cos(rotation) + z * Math.sin(rotation);
    const zr = -x * Math.sin(rotation) + z * Math.cos(rotation);
    const perspective = 1 / Math.max(0.5, 1 + zr * 0.45);
    return [
      w / 2 - xr * h * perspective * zoom,
      h / 2 + y * h * perspective * zoom,
    ];
  };
  ctx.lineWidth = overlay ? 0.65 : 0.85;
  for (const edge of edges) {
    const a = project(edge.start),
      b = project(edge.end);
    const depth = (points[edge.start * 3 + 2] + points[edge.end * 3 + 2]) / 2;
    ctx.strokeStyle = overlay
      ? "rgba(105,226,246,.55)"
      : `hsla(${220 + Math.max(-0.15, Math.min(0.15, depth)) * 450},90%,72%,.75)`;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#b5ff74";
  for (const edge of lips) {
    const a = project(edge.start),
      b = project(edge.end);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  ctx.fillStyle = "#ffa788";
  for (const index of [1, 4, 13, 14, 33, 61, 133, 152, 263, 291, 362]) {
    const p = project(index);
    ctx.beginPath();
    ctx.arc(p[0], p[1], 2, 0, Math.PI * 2);
    ctx.fill();
  }
}
