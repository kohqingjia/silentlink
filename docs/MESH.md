# 3D motion lab

Open **https://silentlink.kohqingjia.io/mesh**. The existing English video model
remains at `/`, and AirPods research at `/airpods`.

## Try it

1. Enable the camera. The first visit downloads approximately 19 MB of tracking
   assets from SilentLink, with measured download percentage and estimated time.
2. Switch between **Camera + mesh** and **Mesh only**. Rotate the mesh-only view.
3. Enter the short sentence you will mouth, press **Record sentence**, wait for
   the countdown, and finish when done (eight-second maximum).
4. Replay or download the motion locally. Connect the existing dashboard key and
   choose **Save sentence motion** to add a labelled example to your private VPS
   workspace. Previewing or recording alone never uploads anything.
5. Record three separate takes each of at least two distinct short phrases. Use
   **Test fresh motion** for another take. The expected text is used only after
   recognition, to calculate word error rate and exact phrase accuracy.
6. Confirm the actual sentence before saving a test take as another example.
   Predictions are never automatically accepted as training labels.

## What the wireframe represents

MediaPipe Face Landmarker estimates 478 XYZ face landmarks and a head-pose matrix
for each camera frame. Lines join these tracked points; the lip contour is
highlighted. Rotation projects the estimated 3D coordinates from another angle.
This is a sparse face surface, with inferred depth from one webcam, **not** a
measured depth scan, a reconstruction of the back of the head, or a dental scan.

The tracker runs in a browser worker. Camera images stay on the device in this
lab; no microphone or MediaRecorder is used. Capture JSON contains dimensions,
schema version, relative millisecond timestamps, face counts, 478 XYZ points per
tracked frame, and a 4×4 head-pose matrix. Coordinates are rounded to five decimal
places. Missing-face frames have empty geometry. The replay reconstructs movement
from these numbers without any source video, texture, or audio.

Coordinates remain personal facial data and can reproduce facial shape; they
are not anonymous. Text JSON is not necessarily smaller than compressed video.

## Learning and honest limitations

The current motion-only baseline normalizes lip landmarks for position, scale
and estimated head rotation, interpolates time, and compares sequences with
dynamic time warping. It uses the three nearest examples per eligible phrase.
Only phrases with at least three examples participate; two eligible phrases are
required. Experimental distance/margin thresholds reject unclear matches. A
distance is **not** a confidence probability. No measured recognition accuracy
is claimed by the implementation or synthetic tests.

Adding correctly labelled, varied examples can improve matching. More usage or
repeated incorrect labels do not guarantee improvement. The system does not
fine-tune a neural sentence recognizer and cannot compose unseen English
sentences from these examples. Mesh geometry also discards pixel details such
as teeth and tongue appearance. The existing Auto-AVSR English model requires
temporary mouth video; stored meshes cannot be substituted into that model.

The next research step for unseen sentences would require a sequence model
trained on paired landmark sequences and transcripts, with separate sessions
and days held out for evaluation. No calibration sentence covers the dictionary.

## Storage and validation

`/api/vision/mesh/*` uses the existing bearer-key owner authentication. Only
explicit saves retain captures in the private `vision_data/mesh.sqlite3` volume;
tests retain prediction/score metadata for seven days, not their input geometry.
Saved examples remain until deleted, with a limit of 200 per owner. Backups
expire after 14 days; deleting a record does not delete external downloads.
Training takes are excluded from fresh tests by exact capture equality. This
prevents accidental replay testing, not malicious forgery or near-duplicate
evaluation leakage. Review balanced results from genuinely new takes/days.

The API rejects unknown/image/video fields, oversized payloads, invalid matrices
or coordinates, multiple faces, excessive tracking loss, low frame rates,
interrupted timing, and insufficient mouth movement. Uploads have size/rate/time
bounds; simultaneous comparisons are bounded. An accepted save is idempotent by
capture ID. A cancelled upload already accepted by the server can still appear
in the library. Deleting examples affects future comparisons; old test scores
retain the original training ID snapshot.

## Build and validation

`npm run dev` and `npm run build` generate ignored tracker assets from the locked
MediaPipe package and a SHA-256-verified official model download. They are served
from SilentLink, not a third-party CDN at runtime. Keep the proxy CSP's
`'wasm-unsafe-eval'`, `worker-src 'self'`, and `connect-src 'self' blob:` entries.

Run `pytest -q vision/tests`, `npm run build`, and `npx playwright test` in the
appropriate directories. Python geometry and browser worker fixtures validate
contracts, owner isolation, timing, label independence, and UI behavior; they do
not measure lip-reading accuracy. Deployment smoke testing additionally uses the
actual MediaPipe model and a video-fed browser camera, checks coordinate-only
upload/replay/deletion, and removes the temporary test workspace afterward.

Research references: [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker),
[SilentSpeak landmark-based word recognition](https://github.com/shashank11yadav/SilentSpeak).
SilentLink's current motion matcher does not use SilentSpeak's ONNX model.
