# SilentLink

**A real-data research platform for AirPods headphone motion and silent articulation.**

SilentLink records the processed motion that Apple exposes, stores it locally on an iPhone, and optionally uploads it to a private research API and dashboard. It does **not** transcribe silent speech. Whether these measurements contain useful speech-related information is an open research question.

## Milestone status

| Area | Implemented | Verification / remaining work |
| --- | --- | --- |
| iOS recorder | Public Core Motion API, authorization/availability, countdown, timed capture, live charts, motion timestamps, acceleration/rotation/gravity/quaternion, recovery drafts, JSON/CSV sharing, local-only default, foreground upload queue and Keychain credentials | Swift syntax checked; GitHub CI compiles the app. Actual permissions, AirPods delivery, disconnection, gaps and offline recovery require a physical iPhone. |
| Backend | FastAPI, PostgreSQL metadata, protected JSON files, migrations, hashed device keys, owner isolation, sessions, idempotent uploads, export, deletion, size/rate limits and health | Automated API validation/access/export tests; production smoke checks described in deployment handoff. |
| Dashboard | Next.js/TypeScript/Tailwind, real recording library, filters, per-session grouping, real-data overlays, CSV/ZIP download and deletion | Production build and type check. Empty until authenticated real uploads exist. No fabricated plots or metrics. |
| Offline analysis | Dataset validation, timestamp checks, gap-aware resampling/filtering, non-overlapping windows, features, logistic regression, majority/chance baselines, separate session/day evaluation | Automated preprocessing and leakage checks. No real data has been collected or model trained. |
| Audio / inference / LLM | Deliberately disabled | Separate, explicitly enabled audio experiment comes next. No `/predict` route or automatic LLM calls. |

## Repository

```text
ios/              Native SwiftUI iPhone app + generated Xcode project
backend/          FastAPI service, SQLAlchemy models, Alembic migration, tests
dashboard/        Static-export Next.js dashboard (same-origin API)
ml/               Offline signal analysis and honest baseline evaluation
infrastructure/   Reverse proxy example, consistent backups and health checks
docs/             API contract, protocol, deployment and limitations
```

Architecture: **AirPods → normal Bluetooth pairing with iPhone → native app → HTTPS → VPS**. The AirPods never connect to the VPS. There is no web or simulator substitute for the native motion recorder.

## Run on your physical iPhone

1. Install **Xcode 16 or later**, including an iOS SDK. Command Line Tools alone are insufficient. iOS 17+ is the deployment target; connection monitoring outside recording uses the documented iOS 18+ API when available.
2. Clone the repository and open `ios/SilentLink.xcodeproj`. The project is already generated. To regenerate after project structure changes, install [XcodeGen](https://github.com/yonaskolb/XcodeGen), then run `cd ios && xcodegen generate`.
3. Select the **SilentLink** target → **Signing & Capabilities** → choose your Apple development team and a unique bundle identifier. No signing credentials are committed.
4. Connect the iPhone, trust the Mac, enable Developer Mode if iOS asks, and select the **physical iPhone** as the destination. Build and run.
5. Pair the AirPods normally in iOS Bluetooth settings and wear them. SilentLink cannot verify the exact AirPods SKU; it checks whether headphone motion is available.
6. Open Recorder → **Refresh availability**. Start a short **Rest** trial and allow Motion & Fitness when prompted. If permission is denied, enable it in iOS Settings → Privacy & Security → Motion & Fitness.
7. Keep the app in the foreground. A 3-second countdown precedes collection. The app stops and saves an interrupted recording on backgrounding or disconnection. Motion updates stopping for three seconds after the first sample also end collection. Initial permission/data delivery has a 30-second timeout.
8. Open Library → **CSV** or **JSON** to export. JSON includes labels, session IDs, units by schema, interruptions and raw *processed* measurements. CSV contains numeric samples only; keep JSON alongside CSV to preserve metadata.

Local files use iOS file protection and are excluded from iCloud backups. The device key uses Keychain `WhenUnlockedThisDeviceOnly`. Every second, an active recording with enough samples is checkpointed; the next launch recovers a partial draft and flags it as interrupted. A crash can lose up to the latest checkpoint interval. Keep recordings backed up by explicit export if they matter.

### Connect the iPhone and dashboard to the VPS

1. Obtain a **device API key** using the provisioning command below. Use separate keys for the phone and dashboard under the same owner.
2. In the app’s Settings, enter the HTTPS server **origin**, with no path, and paste the phone key.
3. Turn off **Keep all recordings local**, then tap **Upload saved recordings**. This opt-in permits all saved, not-yet-uploaded recordings to upload.
4. Uploads run while the app is open, retry after connectivity returns or when you tap Upload, and resume from persisted status after restart. Conflicting IDs return an error instead of overwriting data. A successful upload never deletes the local copy. An upload interrupted after server success is safe to retry.
5. Open the dashboard and choose **Connect workspace**. Paste the dashboard device key. Keys stay only in that tab’s memory. Reloading requires reconnecting.

Turning local-only mode back on cancels the current upload task and stops further uploads. A request already accepted by the server may have completed; the setting does not delete existing server copies. Deleting in the dashboard deletes the server file/metadata; deleting on iPhone deletes only the local copy. Neither deletes external exports or retained backups.

## Local development

Python 3.12 and Node.js 22 are the tested toolchain. PostgreSQL 17 is the deployment database.

```sh
python3.12 -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements-dev.txt -r ml/requirements.txt
pytest -q
cd dashboard
npm ci
npm run build
```

Production Python dependencies are pinned in `backend/requirements.lock`; `dashboard/package-lock.json` pins the dashboard. Docker builds use the lock files. Tests generate explicitly documented synthetic fixtures in temporary test directories; do not use them for research. The production API rejects payloads marked synthetic. That marker is provenance supplied by the client, not proof that measurements came from real hardware.

For an isolated local API without Docker, SQLite is supported for development/tests only:

```sh
cd backend
export DATABASE_URL=sqlite:///./development.sqlite
export DATA_DIR=./data
alembic upgrade head
python -m app.provision --owner researcher --device local-dashboard
uvicorn app.main:app --port 8000
```

The native app requires HTTPS. For browser development, use `npm run dev` and a local reverse proxy that routes `/api/*` and `/health` to port 8000 and all other paths to port 3000, under one origin. No CORS wildcard or browser credential storage is enabled. Alternatively, serve `dashboard/out` and the API through the Caddy example with a real test hostname.

## VPS deployment

The server needs Docker Engine and Compose, a reachable hostname and HTTPS reverse proxy. Rough starting budget: **2 vCPU, 2 GB RAM, 10 GB free storage**, with additional storage sized to real recordings and backups. The dashboard build may need another 1–2 GB temporarily. No GPU is required. ML runs offline and is not part of the serving containers.

```sh
git clone https://github.com/kohqingjia/silentlink.git
cd silentlink
cp .env.example .env
chmod 600 .env
# Replace POSTGRES_PASSWORD with random hex; choose the existing proxy network.
# For a fresh proxy network only:
docker network create silentlink-edge
# Set PROXY_NETWORK in .env to that network (or your existing Caddy network).
docker compose up -d --build
docker compose ps
```

Append the hostname block from `infrastructure/Caddyfile.example` to the existing Caddy configuration, using a hostname that resolves to the VPS. Caddy must join `PROXY_NETWORK`. Validate the full configuration before reloading. The block routes `/api/*` and `/health` to `silentlink-api:8000`, all other paths to `silentlink-dashboard:8080`, and obtains HTTPS certificates. **No container in this Compose file publishes a host port**, including PostgreSQL. Existing VPS applications are independent.

On startup the API runs `alembic upgrade head`. Provision device keys on the VPS:

```sh
docker compose exec api python -m app.provision --owner researcher --device iphone
docker compose exec api python -m app.provision --owner researcher --device dashboard
# Revoke all keys issued for a device:
docker compose exec api python -m app.provision --owner researcher --device iphone --revoke
```

A key grants access to all recordings owned by its owner. New owners isolate datasets. There is no public registration or role hierarchy in this personal research milestone. Only SHA-256 digests of high-entropy random keys are stored in PostgreSQL. Treat plaintext keys as credentials; do not paste them into GitHub, URLs or screenshots.

Check `https://YOUR_HOST/health` and `docker compose ps`. Read `docs/DEPLOYMENT.md` for this installation, rollback, backup/restore and monitoring. Do not commit `.env`, exports, recordings, tokens or participant information.

## First experiment

Start with `docs/PROTOCOL.md`. Collect balanced, randomized trials including negative controls across several sessions and days. The initial task is **whether anything reproducible is detectable**, not arbitrary-sentence transcription.

Export a dataset ZIP from the authenticated dashboard. Inspect actual traces first:

```sh
# Extract only your trusted export, then plot a real recording JSON.
PYTHONPATH=ml python -m silentlink_ml.plot path/to/recording.json plot.png
# Use an entire later day's session as held-out data; repeat flag for more sessions.
PYTHONPATH=ml python -m silentlink_ml.pipeline silentlink-dataset.zip \
  --heldout-session UUID-OF-HELDOUT-SESSION --rate 25 --window 2 \
  --output reports/evaluation.json
```

Choose `--rate` no higher than the measured typical sensor rate; the pipeline refuses upsampling. It aligns samples relative to first timestamp, splits at gaps greater than 2.5 median intervals, regularizes/filter-resamples contiguous segments with anti-aliasing, and forms nonoverlapping windows. It skips interrupted recordings. Scaling is learned from training data only. Whole sessions are split before windowing, with **disjoint UTC days** enforced; choose held-out sessions accordingly if local dates cross UTC midnight.

The report contains accuracy, per-class precision/recall/F1 and counts, confusion matrix, majority/chance baselines, false activation fraction on negative-control windows, held-out session IDs and a dataset hash. The false activation metric is **per window**, not events/hour. It reports no model quality until run on real data. Adjacent windows are correlated; do not equate the number of windows to independent participants. Repeat across multiple held-out days and report variation. A model that fails to beat controls is a useful negative result.

## Technical limits and next steps

- Public APIs deliver processed device motion, not raw speech accelerometer or private microphone channels. The sample rate is observed; this manager offers no documented rate-setting property.
- Acceleration/gravity are in **g**, rotation rate in **rad/s**, time in **seconds**, and attitude is a quaternion. Sensor timestamps use a monotonic clock; absolute recording start is estimated against system uptime. This is not hardware-synchronized audio/motion capture.
- Head movement, fit, chewing, session order and environment may dominate signals. Repeated windows from one clip must not cross evaluation splits.
- Motion sensor availability does not demonstrate useful silent-speech information. No real-device testing or ML performance is claimed by this source release.
- Optional AVFoundation audio is **not implemented yet** and no microphone permission is requested. A future opt-in implementation must log the actual route, interruption state and audio format, handle Bluetooth processing/quality/latency trade-offs, and never claim access to individual internal microphones.
- PyTorch/CNNs, calibrated `/api/v1/predict`, an evaluation-report dashboard, LLM prompts and TTS remain later milestones. Prediction stays disabled until meaningful held-out evidence exists and the interpretation can be confirmed.

### Apple references checked before sensor implementation

The installed macOS 14.4 SDK’s `CMHeadphoneMotionManager.h` and delegate header confirmed the base manager, availability, authorization and callback signatures. This Mac had no full Xcode/iOS SDK installation. Current Apple documentation was also consulted:

- [CMHeadphoneMotionManager](https://developer.apple.com/documentation/coremotion/cmheadphonemotionmanager)
- [Motion update handler](https://developer.apple.com/documentation/coremotion/cmheadphonemotionmanager/startdevicemotionupdates(to:withhandler:))
- [Connection/disconnection delegate](https://developer.apple.com/documentation/coremotion/cmheadphonemotionmanagerdelegate)
- [Core Motion updates, including iOS 18 connection monitoring](https://developer.apple.com/documentation/updates/coremotion)
- [Processed device-motion data](https://developer.apple.com/documentation/coremotion/getting-processed-device-motion-data)

`NSMotionUsageDescription` is present in the app configuration. CI compilation does not substitute for running the app with actual AirPods.
