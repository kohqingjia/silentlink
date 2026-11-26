// All model code and assets are served by SilentLink; no frames leave this worker.
import {
  FaceLandmarker,
  FilesetResolver,
} from "/mediapipe/1.2.3/vision_bundle.mjs";
let tracker;
let lastTimestamp = -1;
const base = "/mediapipe/1.2.3";
async function download(url, total, offset, all, started) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body)
    throw Error(
      "Tracker download failed. Retry when the connection is stable.",
    );
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    count += value.length;
    chunks.push(value);
    const loaded = offset + count;
    postMessage({
      type: "progress",
      percent: Math.min(100, Math.round((loaded * 100) / all)),
      stage: "Downloading face tracker",
      eta: Math.round(
        (((performance.now() - started) / 1000) * Math.max(0, all - loaded)) /
          loaded,
      ),
    });
    if (count > total + 1024)
      throw Error("Unexpected tracker asset size. Refresh and retry.");
  }
  const bytes = new Uint8Array(count);
  let index = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, index);
    index += chunk.length;
  }
  return bytes;
}
self.onmessage = async ({ data }) => {
  if (data.type === "init") {
    try {
      const manifestResponse = await fetch(`${base}/manifest.json`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!manifestResponse.ok)
        throw Error("Tracker files are unavailable. Please retry.");
      const manifest = await manifestResponse.json();
      const started = performance.now(),
        total = manifest.model + manifest.wasm;
      const model = await download(
        `${base}/face_landmarker.task`,
        manifest.model,
        0,
        total,
        started,
      );
      const wasm = await download(
        `${base}/wasm/vision_wasm_module_internal.wasm`,
        manifest.wasm,
        manifest.model,
        total,
        started,
      );
      postMessage({
        type: "progress",
        percent: null,
        stage: "Starting face tracking on your device",
        eta: null,
      });
      const binaryUrl = URL.createObjectURL(
        new Blob([wasm], { type: "application/wasm" }),
      );
      try {
        const fileset = await FilesetResolver.forVisionTasks(
          `${base}/wasm`,
          true,
        );
        fileset.wasmBinaryPath = binaryUrl;
        // CPU WebAssembly is supported in workers across current desktop browsers.
        tracker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: model, delegate: "CPU" },
          runningMode: "VIDEO",
          numFaces: 2,
          outputFacialTransformationMatrixes: true,
        });
      } finally {
        URL.revokeObjectURL(binaryUrl);
      }
      postMessage({
        type: "ready",
        edges: FaceLandmarker.FACE_LANDMARKS_TESSELATION,
        lips: FaceLandmarker.FACE_LANDMARKS_LIPS,
      });
    } catch (error) {
      postMessage({ type: "error", message: String(error?.message || error) });
    }
  }
  if (data.type === "frame") {
    try {
      if (!tracker) return;
      lastTimestamp = Math.max(lastTimestamp + 1, Math.round(data.timestamp));
      const result = tracker.detectForVideo(data.bitmap, lastTimestamp);
      const points = result.faceLandmarks[0];
      const xyz = points ? points.flatMap((p) => [p.x, p.y, p.z]) : [];
      postMessage({
        type: "frame",
        timestamp: data.timestamp,
        faces: result.faceLandmarks.length,
        xyz,
        pose: result.facialTransformationMatrixes[0]?.data || [],
        width: data.width,
        height: data.height,
      });
    } catch (error) {
      postMessage({
        type: "error",
        message: "Face tracking stopped. Restart the camera and try again.",
      });
    } finally {
      data.bitmap.close();
    }
  }
};
