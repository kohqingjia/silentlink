# API v1

All `/api/v1/*` endpoints require `Authorization: Bearer DEVICE_KEY`. `/health` exposes only service status/version and disabled inference. Keys map to an owner and a device label; ownership is checked on every resource query. No browser session cookie or CORS wildcard is used.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Database-backed health check |
| GET | `/api/v1/me` | Validate key and show feature availability |
| POST / GET | `/api/v1/sessions` | Create an immutable client-ID session / list owned sessions |
| GET | `/api/v1/sessions/{id}` | Owned session metadata |
| POST / GET | `/api/v1/recordings` | Ingest / list owned metadata |
| GET | `/api/v1/recordings/{id}?format=json\|csv` | Download protected samples |
| DELETE | `/api/v1/recordings/{id}` | Delete owned metadata and stored file |
| GET | `/api/v1/datasets/export?session_id=UUID` | ZIP of JSON recordings and a session manifest |

Session fields: UUID `id`, `experiment` (1–120 chars), pseudonymous `device` (1–128 chars), timezone-aware `started_at`, optional `notes` (≤2000), `protocol_version: motion-v1`. Reusing the same ID/metadata is safe; changing metadata under the same ID returns 409.

Recording fields: `schema_version: 1`, UUID `id`, UUID `session_id`, `label`, `recording_type: motion`, `source: cmheadphonemotionmanager`, `synthetic: false`, timezone-aware `started_at`, matching `device`, `os_version`, `requested_duration_s` (5–300), `interruptions: [{t, reason}]`, `samples`.

Sample fields: relative `t` (first sample zero), monotonic `sensor_timestamp`, `user_acceleration: {x,y,z}`, `rotation_rate: {x,y,z}`, `gravity: {x,y,z}`, `attitude: {x,y,z,w}`. All values must be finite; timestamps strictly increase and relative/monotonic clocks must agree within 2 ms. Units: seconds, g, rad/s, g, quaternion respectively. At least 2 and at most 60,000 samples; samples may not exceed requested duration by more than 2 seconds. Current iOS UI offers 10, 15, 30 and 60 seconds.

Recordings use canonical content hashes and client-generated UUIDs. Identical retry succeeds; a changed payload using the same ID returns 409. The API computes timing statistics from the payload rather than trusting a supplied rate. IDs are never used as arbitrary filesystem paths. Files contain the full validated recording, not one SQL row per sample.

Lists support `limit` (1–1000) and `offset`. Recordings can also filter exact `session_id` and `label`. Export is limited to 500 recordings and 512 MiB uncompressed; use a session filter for larger datasets. A full export contains owned session metadata and selected recording JSON. ZIP contents are never extracted by the backend.

Limits: 12 MiB request body including streamed/chunked uploads, 120 requests per owner/minute, 600 requests per upstream peer/minute, 32 concurrent ASGI requests. In-memory rate limits are per process and reset on restart; use one API worker. The peer limiter conservatively sees the proxy address because untrusted forwarded headers are not accepted. Multi-instance service needs a shared rate-limit store and coordinated storage before scaling.

Errors: 401 unauthenticated; 404 missing/not-owned resource; 409 ID conflict; 413 oversized body; 422 invalid data; 429 rate limited (`Retry-After: 60`); 503 unavailable storage/database. Logs contain random request ID, method, status and elapsed time, never authorization, query strings or sensor bodies.

The API does not prove sensor provenance. It rejects `synthetic: true`, but a caller could falsely label a payload. Research provenance must include protocol records and trusted device collection. Tests use temporary, explicitly documented synthetic fixtures and never run against production datasets.
