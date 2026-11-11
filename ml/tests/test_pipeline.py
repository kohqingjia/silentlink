"""Synthetic test fixtures. Never export these as research recordings."""
import copy
import json
import zipfile
import numpy as np
import pytest
from silentlink_ml.pipeline import features, load_dataset, split_sessions, validate_recording, windows


def fixture_recording():
    return {'id': 'test', 'session_id': 's1', 'label': 'SYNTHETIC TEST ONLY', 'started_at': '2026-01-01T00:00:00Z',
            'synthetic': False, 'source': 'cmheadphonemotionmanager', 'schema_version': 1, 'recording_type': 'motion',
            'samples': [{'t': i / 50, 'sensor_timestamp': 10 + i / 50,
                         'user_acceleration': dict(x=float(np.sin(i / 50)), y=0, z=0),
                         'rotation_rate': dict(x=0, y=0, z=0)} for i in range(501)]}


def test_window_resampling_and_features():
    result = windows(fixture_recording())
    assert len(result) == 5
    assert result[0].shape == (50, 6)
    assert features(result[0]).shape == (36,)
    assert np.isfinite(features(result[0])).all()


def test_no_bridging_large_gaps():
    r = fixture_recording()
    r['samples'] = r['samples'][:151] + r['samples'][300:]
    assert len(windows(r)) == 3


@pytest.mark.parametrize('fault', ['order', 'nan', 'synthetic', 'clock'])
def test_invalid_samples(fault):
    r = fixture_recording()
    if fault == 'order': r['samples'].reverse()
    if fault == 'nan': r['samples'][0]['user_acceleration']['x'] = float('nan')
    if fault == 'synthetic': r['synthetic'] = True
    if fault == 'clock': r['samples'][5]['sensor_timestamp'] += .01
    with pytest.raises(ValueError): validate_recording(r)


def test_no_upsampling():
    with pytest.raises(ValueError, match='upsample'): windows(fixture_recording(), rate=100)


def test_session_day_isolation():
    r = fixture_recording(); second = copy.deepcopy(r); second['session_id'] = 's2'
    sessions = {'s1': {'started_at': '2026-01-01T10:00:00Z'}, 's2': {'started_at': '2026-01-01T20:00:00Z'}}
    with pytest.raises(ValueError, match='different UTC days'): split_sessions([r, second], sessions, ['s2'])
    sessions['s2']['started_at'] = '2026-01-02T10:00:00Z'
    a, b = split_sessions([r, second], sessions, ['s2'])
    assert {i['session_id'] for i in a}.isdisjoint(i['session_id'] for i in b)


def test_dataset_manifest_validation(tmp_path):
    r = fixture_recording(); path = tmp_path / 'SYNTHETIC_TEST_ONLY.zip'
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('manifest.json', json.dumps({'schema_version': 1, 'synthetic': False, 'sessions': [{'id': 's1'}], 'recordings': ['test']}))
        z.writestr('recordings/test.json', json.dumps(r))
    sessions, recordings = load_dataset(path)
    assert recordings[0]['id'] == 'test'
    assert 's1' in sessions
