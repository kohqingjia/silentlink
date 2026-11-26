import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "1.2.3";
const destination = path.join(root, "public/mediapipe", version);
const packageRoot = path.join(root, "node_modules/@mediapipe/tasks-vision");
await mkdir(path.join(destination, "wasm"), { recursive: true });
for (const file of [
  "wasm/vision_wasm_module_internal.js",
  "wasm/vision_wasm_module_internal.wasm",
  "vision_bundle.mjs",
]) {
  await copyFile(path.join(packageRoot, file), path.join(destination, file));
}
const expected =
  "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";
const modelPath = path.join(destination, "face_landmarker.task");
let model = await readFile(modelPath).catch(() => null);
const hash = (data) => createHash("sha256").update(data).digest("hex");
if (!model || hash(model) !== expected) {
  const response = await fetch(
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    { signal: AbortSignal.timeout(60000) },
  );
  if (!response.ok)
    throw new Error(`Face model download failed: ${response.status}`);
  model = Buffer.from(await response.arrayBuffer());
  if (model.length > 16 * 1024 * 1024 || hash(model) !== expected)
    throw new Error("Face model integrity check failed");
  await writeFile(modelPath, model);
}
const wasm = await readFile(
  path.join(destination, "wasm/vision_wasm_module_internal.wasm"),
);
await writeFile(
  path.join(destination, "manifest.json"),
  JSON.stringify({ model: model.length, wasm: wasm.length }),
);
const { FaceLandmarker } = await import(
  pathToFileURL(path.join(packageRoot, "vision_bundle.mjs")).href
);
await writeFile(
  path.join(destination, "topology.json"),
  JSON.stringify({
    edges: FaceLandmarker.FACE_LANDMARKS_TESSELATION,
    lips: FaceLandmarker.FACE_LANDMARKS_LIPS,
  }),
);
console.log("Verified self-hosted face tracker assets ready");
