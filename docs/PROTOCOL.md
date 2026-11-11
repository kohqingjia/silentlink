# First feasibility experiment · motion-v1

**Question:** Do publicly available processed headphone-motion measurements distinguish silent articulation from rest and ordinary movement, reproducibly across days?

1. Use the same physical iPhone and AirPods fit. Record the model, iOS version, fit/posture and environment in your study notes. The app records a pseudonymous installation ID and iOS version; it does not query private AirPods firmware interfaces.
2. Start a named experiment and a new session for each visit. Collect at least three separate days if practical; pilot results remain exploratory. Plan a later day as the untouched test set before examining results.
3. Use the app’s 3-second countdown and 15-second trials. Keep posture steady for the phrase/rest trials. Silently articulate the assigned phrase at a consistent, comfortable pace. Do not silently articulate during the negative-control trials.
4. Classes: Rest; Silent articulation: Hello; Silent articulation: Thank you; Silent articulation: How are you?; Normal speaking; Chewing; Smiling; Walking; Head turning. Custom phrases are allowed but require enough repetitions on every day.
5. Randomize the order (e.g. shuffle label cards) and collect 10–20 trials per class per day. Avoid collecting all of one class in one continuous block. Take breaks. Do not perform walking trials near traffic or while operating a vehicle.
6. Inspect sample count, observed rate, gaps and interruptions. Mark protocol deviations in external study notes. A gap is an interval >2.5 times the recording’s median interval; this is a heuristic, not a recovered count of dropped hardware samples. Do not choose a sampling-rate assumption to force a result.
7. Keep a raw JSON copy and protect it like personal research data. The public repository contains source code only. Enable server uploads explicitly, then inspect actual recordings and controls.
8. Compare rest vs silent articulation, then articulation vs movement controls, then only if warranted a small phrase vocabulary. The supplied baseline uses the recording labels as-is; for binary tasks, create a documented derived dataset with an explicit label mapping while preserving originals.
9. Hold out whole sessions and different days, not random windows. Check class balance, false activation on controls, majority/uniform chance baselines and per-class errors. Repeat held-out evaluation across days; do not tune on the final test day.
10. Record negative findings. Better-than-chance on a small convenient sample is insufficient evidence for unrestricted speech recognition. Stop escalating model complexity if the signal cannot survive movement controls and day changes.

## Device acceptance checklist (requires you and your iPhone)

- Fresh install: allow and deny motion permission; denied state gives a useful message.
- No headphones / unsupported headphones: no fabricated samples, clear unavailable state.
- AirPods connected: live plots and monotonic timestamps; note observed delivery rate.
- Capture a timed trial, an early stop, a disconnect and a background interruption.
- Kill/reopen during collection: recovered draft marked interrupted; inspect sample loss.
- Export CSV and JSON; verify label/session metadata and sample counts.
- Airplane mode: save locally, enable network again with app open, retry queued upload.
- Repeated upload: exactly one backend record; expired/revoked key: visible error.
- Local-only mode: no upload requests. Switching it back on stops new requests.
- Dashboard overlay matches exported real measurements; deletion does not remove the iPhone copy.

Audio is outside this milestone. If added later, obtain explicit opt-in separately, inspect AVAudioSession’s actual route, and report Bluetooth input/output processing and latency rather than assuming a private inward-facing microphone channel.
