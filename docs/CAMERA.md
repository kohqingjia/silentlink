# Phase 1: webcam silent speech

The website is the complete interface. A CPU inference service on the existing
VPS runs [Auto-AVSR](https://github.com/mpc001/auto_avsr); the old motion dashboard
and iOS app remain Phase 2 at `/airpods`.

## First use

1. Open https://silentlink.kohqingjia.io/ in a current desktop browser.
2. Connect using the existing private dashboard key. It stays in sessionStorage
   for the current tab; Disconnect clears it.
3. Enable Camera, face the light, and keep the microphone off (the app never requests it).
4. In Speak, record a short phrase after the countdown. Stop manually or let the
   eight-second limit stop it. Review the raw transcript before Speak text.
5. In Teach words, choose at least two words and record three or more separate
   takes of each. Features and labels are saved privately; keeping original
   video is a separate opt-in. This builds a nearest-example vocabulary, not
   a full-dictionary fine-tune.
6. In Test accuracy, choose the sentence or personal model, enter the expected
   words, and record a **new take**. Reference text never enters the inference
   worker. The worker sees only the video path and whether to decode a sentence.

There is no single universal calibration sentence. Sounds such as b/p/m can look
alike, and surrounding sounds change articulation. The practice prompts vary
visible movements but make no claim of complete phonetic coverage. Try multiple
sessions and varied conditions. A model trained on spoken video may perform
differently on silent mouthing.

## Live behavior and progress

Live phrases captures four seconds, processes one clip, then counts down for the
next phrase. It deliberately waits for server capacity; mouth words only during
the recording cue. This is experimental phrase-at-a-time inference, not causal
frame-by-frame transcription. Idle faces may still produce plausible nonsense.

Upload percentage comes from transferred bytes. Face tracking percentage comes
from processed frames. Model-integrity percentage comes from bytes verified.
Encoder progress counts completed model layers. Sentence decoding has no reliable
denominator and displays a named stage plus elapsed time. ETA is explicitly an estimate based on the previous eight comparable
completions, available after two measurements; first-run ETA is unknown. Jobs time
out after 180 seconds. Cancel interrupts the worker and reloads its model before
the next queued job. One CPU job runs at a time, with bounded queues and owner limits.

No paid API, GPU rental, Apple developer subscription, Xcode, or new service is
required. Existing VPS/domain costs continue. Browser TTS uses available voices;
online voices may send text to the browser's provider. Playback is manual.

## Evaluation

- Exact phrase accuracy = exact normalized matches / fresh tests × 100.
- WER = (substitutions + deletions + insertions) / reference words × 100. Lower
  is better; WER can exceed 100%, and is not a confidence score.
- Personal rejection counts as an unsuccessful test. Similarity is not a probability.
- Every personal test snapshots its training examples before inference and records
  those IDs, so later examples cannot change an earlier prediction. Do not reuse a
  training video as a test; browser tests always capture a new take.
- Aggregate UI metrics cover each model separately, the past seven days, latest
  500 records. Results are experiments, not a population benchmark. Export JSON
  includes references, predictions, timing, error counts, and training IDs.

## Data and deployment

`vision` runs as a nonroot container (3 CPUs, 6 GB memory) with a warm checkpoint.
Authentication delegates to the existing API; all recordings are owner scoped.
SQLite metadata and opted-in training videos live in `vision_data`. Transcription
and test videos are deleted on completion/failure/cancel. Their result metadata
expires after seven days. Taught examples persist until deleted, capped at 200.
Backups retain data for 14 days; deleting live data does not rewrite older backups.
The public repository contains no personal recordings or credentials.

Download the checkpoint separately, verify the SHA-256 from `vision/NOTICE.md`,
and place it at `/home/qingjia/apps/silentlink-models/autoavsr.pth`. It must be
readable by container UID 10001. The bind mount is read only. Source provenance
and licensing are in `vision/NOTICE.md`.

```sh
docker compose build vision dashboard
docker compose up -d vision dashboard
docker compose logs --tail=30 vision
```

Route `/api/vision/*` to `silentlink-vision:8000` **before** the existing API route.
Use `camera=(self)` in Permissions-Policy, keeping microphone/geolocation denied.
See `infrastructure/Caddyfile.example`. `/api/vision/status` distinguishes the
model's readiness from the process health check. Do not delete existing DB volumes.

## Open-source research

- Auto-AVSR: Apache 2.0 source, established sentence model; selected and pinned.
- [Chaplin-UI](https://github.com/loganngarcia/chaplin-ui): useful web inference
  workflow, but recorded clips rather than a causal streaming decoder.
- [SilentSpeak](https://github.com/shashank11yadav/SilentSpeak): MIT browser
  word-recognition alternative; small-vocabulary personalization is distinct from
  full English sentence transcription. Its source/model is not bundled here.
- [klokie/lip-reader](https://github.com/klokie/lip-reader): UI example whose README
  documents placeholder inference, so it is not used as the recognition engine.

Future work: collect consenting personal recordings, benchmark unseen sessions,
compare temporal embedding/prototype approaches, measure false activations on
rest clips, and evaluate suitable fine-tuning or faster streaming models. None of
these future steps is represented as already validated.

## Deployment verification (2026-11-26)

The real checkpoint and preprocessing/decoding pipeline ran on the VPS with a
public 7.12-second video from `md-vsr/lip-reading-ai/samples/test.mp4`, using three
CPU cores. Processing took 6.21 seconds and detected a face in 98% of frames.
This is a single smoke test, not a throughput benchmark or accuracy measurement;
no verified reference transcript was available. The video is not redistributed
in this repository and is not used to train the personal vocabulary.

Browser tests use Playwright and Chromium's synthetic camera. They verify browser
recording without audio, UI progress, cancellation, teaching/deletion, test scoring,
startup feedback, live-phrase backpressure, permission errors, and responsive layout.
Synthetic UI responses are not ML validation and never reach production storage.

```sh
pytest -q vision/tests
cd dashboard
npm ci
npx playwright install chromium
npm run test:e2e
```
