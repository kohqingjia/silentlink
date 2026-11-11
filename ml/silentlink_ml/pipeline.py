import argparse
import hashlib
import json
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfiltfilt
from sklearn.dummy import DummyClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

CHANNELS = [(name, axis) for name in ('user_acceleration', 'rotation_rate') for axis in ('x', 'y', 'z')]


def validate_recording(recording):
    if recording.get('synthetic') is not False or recording.get('source') != 'cmheadphonemotionmanager':
        raise ValueError('Only explicitly real headphone-motion recordings are accepted')
    if recording.get('schema_version') != 1 or recording.get('recording_type') != 'motion':
        raise ValueError('Unsupported recording schema or type')
    for key in ('id', 'session_id', 'label', 'started_at'):
        if not recording.get(key):
            raise ValueError(f'Missing {key}')
    samples = recording.get('samples', [])
    if len(samples) < 2:
        raise ValueError('At least two samples required')
    t = np.array([s['t'] for s in samples], dtype=float)
    sensor = np.array([s['sensor_timestamp'] for s in samples], dtype=float)
    values = np.array([[s[c][a] for c, a in CHANNELS] for s in samples], dtype=float)
    if not np.isfinite(t).all() or not np.isfinite(sensor).all() or not np.isfinite(values).all():
        raise ValueError('Non-finite measurements')
    if t[0] != 0 or np.any(np.diff(t) <= 0) or np.any(np.diff(sensor) <= 0):
        raise ValueError('Timestamps must increase strictly from zero')
    if not np.allclose(sensor - sensor[0], t, atol=.002, rtol=0):
        raise ValueError('Relative and sensor timestamps disagree')
    return t, values


def load_dataset(path):
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > 10000 or sum(i.file_size for i in infos) > 512 * 1024 * 1024:
            raise ValueError('Dataset exceeds safe import limits')
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('schema_version') != 1 or manifest.get('synthetic') is not False:
            raise ValueError('Unsupported or synthetic dataset')
        sessions = {s['id']: s for s in manifest['sessions']}
        recordings = []
        seen = set()
        fingerprints = set()
        for rid in manifest['recordings']:
            if rid in seen:
                raise ValueError('Duplicate recording ID')
            seen.add(rid)
            r = json.loads(archive.read(f'recordings/{rid}.json'))
            if r['id'] != rid or r['session_id'] not in sessions:
                raise ValueError('Recording/manifest mismatch')
            validate_recording(r)
            fingerprint = hashlib.sha256(json.dumps(r['samples'], sort_keys=True).encode()).hexdigest()
            if fingerprint in fingerprints:
                raise ValueError('Duplicate clip content could leak across sessions')
            fingerprints.add(fingerprint)
            recordings.append(r)
    return sessions, recordings


def windows(recording, rate=25, seconds=2, lowpass_hz=None):
    t, x = validate_recording(recording)
    if rate <= 0 or seconds <= 0 or rate * seconds < 2:
        raise ValueError('Invalid resampling/window parameters')
    median = np.median(np.diff(t))
    observed = 1 / median
    if rate > observed * 1.05:
        raise ValueError(f'Resampling at {rate} Hz would upsample a {observed:.1f} Hz signal; choose a lower rate')
    if lowpass_hz is not None and not 0 < lowpass_hz < rate / 2:
        raise ValueError('Low-pass cutoff must be below target Nyquist frequency')
    # Never interpolate over a gap > 2.5 typical sample intervals.
    split = np.flatnonzero(np.diff(t) > 2.5 * median) + 1
    result = []
    for indices in np.split(np.arange(len(t)), split):
        ts, xs = t[indices], x[indices]
        if len(ts) < 4:
            continue
        # Regularize at observed rate, low-pass before decimation to avoid aliasing.
        grid = np.arange(ts[0], ts[-1] + 1e-9, 1 / observed)
        regular = np.column_stack([np.interp(grid, ts, xs[:, c]) for c in range(xs.shape[1])])
        cutoff = min(lowpass_hz or .4 * rate, .4 * rate, .45 * observed)
        sos = butter(4, cutoff, fs=observed, output='sos')
        if len(regular) < 32:
            continue
        filtered = sosfiltfilt(sos, regular, axis=0)
        target = np.arange(grid[0], grid[-1] + 1e-9, 1 / rate)
        resampled = np.column_stack([np.interp(target, grid, filtered[:, c]) for c in range(xs.shape[1])])
        width = int(round(rate * seconds))
        for start in range(0, len(resampled) - width + 1, width):
            result.append(resampled[start:start + width])
    return result


def features(window):
    centered = window - window.mean(axis=0)
    return np.concatenate([window.mean(axis=0), window.std(axis=0), np.sqrt(np.mean(window ** 2, axis=0)),
                           np.ptp(window, axis=0), np.mean(np.abs(np.diff(window, axis=0)), axis=0),
                           np.mean(np.abs(np.fft.rfft(centered, axis=0)), axis=0)])


def split_sessions(recordings, sessions, heldout_ids):
    known = {r['session_id'] for r in recordings}
    heldout = set(heldout_ids)
    if not heldout or not heldout <= known or not known - heldout:
        raise ValueError('Choose nonempty held-out sessions and leave separate training sessions')
    # Conservative UTC-day split: refuse overlapping days, not only session IDs.
    def utc_day(sid):
        stamp = datetime.fromisoformat(sessions[sid]['started_at'].replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError('Session timestamp requires timezone')
        return stamp.astimezone(timezone.utc).date()
    train_days = {utc_day(s) for s in known - heldout}
    test_days = {utc_day(s) for s in heldout}
    if train_days & test_days:
        raise ValueError('Training and held-out sessions must be on different UTC days')
    return ([r for r in recordings if r['session_id'] not in heldout], [r for r in recordings if r['session_id'] in heldout])


def evaluate(dataset, heldout, rate=25, seconds=2):
    sessions, recordings = load_dataset(dataset)
    train, test = split_sessions(recordings, sessions, heldout)
    skipped = []
    def matrix(items):
        xx, yy = [], []
        for r in items:
            if r.get('interruptions'):
                skipped.append({'id': r['id'], 'reason': 'interrupted recording'}); continue
            parts = windows(r, rate=rate, seconds=seconds)
            if not parts:
                skipped.append({'id': r['id'], 'reason': 'no complete, contiguous windows'}); continue
            xx.extend(features(w) for w in parts); yy.extend([r['label']] * len(parts))
        return np.asarray(xx), np.asarray(yy)
    xtrain, ytrain = matrix(train)
    xtest, ytest = matrix(test)
    if len(set(ytrain)) < 2 or len(ytest) == 0:
        raise ValueError('Need at least two training classes and usable held-out windows')
    if set(ytrain) != set(ytest):
        raise ValueError('Every class must appear in both training and held-out sessions')
    model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, class_weight='balanced', random_state=42))
    model.fit(xtrain, ytrain)
    predicted = model.predict(xtest)
    baseline = DummyClassifier(strategy='most_frequent').fit(xtrain, ytrain).predict(xtest)
    classes = sorted(set(ytrain))
    negative = np.array([not str(label).startswith('Silent articulation:') for label in ytest])
    activations = np.array([str(label).startswith('Silent articulation:') for label in predicted])
    return {'schema_version': 1, 'dataset_sha256': hashlib.sha256(Path(dataset).read_bytes()).hexdigest(),
            'model': 'standard scaler + balanced logistic regression', 'seed': 42,
            'resample_hz': rate, 'window_seconds': seconds, 'evaluation_unit': 'nonoverlapping windows',
            'training_sessions': sorted({r['session_id'] for r in train}), 'heldout_sessions': sorted(heldout),
            'split': 'disjoint sessions and UTC days; split before windowing; scaler fit on train only',
            'accuracy': accuracy_score(ytest, predicted), 'classification_report': classification_report(ytest, predicted, output_dict=True, zero_division=0),
            'classes': classes, 'confusion_matrix': confusion_matrix(ytest, predicted, labels=classes).tolist(),
            'majority_baseline_accuracy': accuracy_score(ytest, baseline), 'uniform_chance_accuracy': 1 / len(classes),
            'false_activation_rate': float(activations[negative].mean()) if negative.any() else None,
            'false_activation_definition': 'fraction of negative-control windows predicted as silent articulation; not events per hour',
            'train_windows_per_class': dict(Counter(ytrain)), 'test_windows_per_class': dict(Counter(ytest)),
            'skipped_recordings': skipped, 'limitations': ['Exploratory closed-set classification, not transcription.', 'Windows within a recording are correlated; window counts are not independent participant counts.', 'Small datasets can produce unstable estimates. Collect multiple days and repeat held-out evaluations.']}


def main():
    parser = argparse.ArgumentParser(description='Evaluate real SilentLink data across sessions and days')
    parser.add_argument('dataset', type=Path)
    parser.add_argument('--heldout-session', action='append', required=True)
    parser.add_argument('--rate', type=float, default=25)
    parser.add_argument('--window', type=float, default=2)
    parser.add_argument('--output', type=Path, default=Path('reports/evaluation.json'))
    args = parser.parse_args()
    report = evaluate(args.dataset, args.heldout_session, args.rate, args.window)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2))
    print(f'Wrote measured evaluation to {args.output}')


if __name__ == '__main__':
    main()
