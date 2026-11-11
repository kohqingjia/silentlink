"""All samples in this file are synthetic fixtures, never research data."""
import copy
import io
import json
import zipfile
from uuid import uuid4
import pytest
from app.config import settings
from app.main import buckets


def fixture_data():
    session = {'id': str(uuid4()), 'experiment': 'SYNTHETIC TEST ONLY', 'device': 'test-device', 'started_at': '2026-01-01T12:00:00Z'}
    zero = {'x': 0, 'y': 0, 'z': 0}
    samples = [{'t': i * .02, 'sensor_timestamp': 10 + i * .02, 'user_acceleration': zero, 'rotation_rate': zero, 'gravity': {'x': 0, 'y': 0, 'z': -1}, 'attitude': {**zero, 'w': 1}} for i in range(100)]
    recording = {'id': str(uuid4()), 'session_id': session['id'], 'label': 'Rest', 'started_at': session['started_at'], 'device': session['device'], 'os_version': 'TEST', 'requested_duration_s': 5, 'synthetic': False, 'samples': samples}
    return session, recording


def upload(client, auth):
    session, recording = fixture_data()
    assert client.post('/api/v1/sessions', json=session, headers=auth).status_code == 201
    response = client.post('/api/v1/recordings', json=recording, headers=auth)
    assert response.status_code == 201, response.text
    return session, recording, response.json()


def test_auth_and_health(client):
    assert client.get('/health').json()['status'] == 'ok'
    assert client.get('/api/v1/sessions').status_code == 401
    assert client.get('/api/v1/me', headers={'Authorization': 'Bearer wrong'}).status_code == 401


def test_roundtrip_retry_csv_export_and_delete(client, auth):
    session, recording, result = upload(client, auth)
    assert result['statistics']['observed_rate_hz'] == pytest.approx(50)
    assert result['statistics']['gap_count'] == 0
    assert client.post('/api/v1/sessions', json=session, headers=auth).status_code == 201
    assert client.post('/api/v1/recordings', json=recording, headers=auth).status_code == 201
    assert len(client.get('/api/v1/recordings', headers=auth).json()) == 1
    rid = recording['id']
    downloaded = client.get(f'/api/v1/recordings/{rid}', headers=auth).json()
    assert downloaded['samples'] == recording['samples']
    csv = client.get(f'/api/v1/recordings/{rid}?format=csv', headers=auth)
    assert len(csv.text.strip().splitlines()) == 101
    export = client.get('/api/v1/datasets/export', headers=auth)
    assert export.status_code == 200, export.text
    with zipfile.ZipFile(io.BytesIO(export.content)) as archive:
        assert json.loads(archive.read('manifest.json'))['recordings'] == [rid]
        assert json.loads(archive.read(f'recordings/{rid}.json'))['samples'] == recording['samples']
    assert client.delete(f'/api/v1/recordings/{rid}', headers=auth).status_code == 204
    assert client.get(f'/api/v1/recordings/{rid}', headers=auth).status_code == 404


def test_owner_isolation(client, auth):
    session, recording, _ = upload(client, auth)
    bob = {'Authorization': 'Bearer test-only-b'}
    assert client.get('/api/v1/sessions', headers=bob).json() == []
    assert client.get('/api/v1/recordings', headers=bob).json() == []
    assert client.get(f'/api/v1/sessions/{session["id"]}', headers=bob).status_code == 404
    assert client.get(f'/api/v1/recordings/{recording["id"]}', headers=bob).status_code == 404
    assert client.delete(f'/api/v1/recordings/{recording["id"]}', headers=bob).status_code == 404
    assert client.post('/api/v1/recordings', json=recording, headers=bob).status_code == 404


@pytest.mark.parametrize('fault', ['duplicate', 'descending', 'misaligned', 'synthetic', 'empty', 'unknown', 'device', 'duration'])
def test_reject_invalid_data(client, auth, fault):
    s, r = fixture_data()
    client.post('/api/v1/sessions', json=s, headers=auth)
    if fault == 'duplicate': r['samples'][1] = copy.deepcopy(r['samples'][0])
    if fault == 'descending': r['samples'].reverse()
    if fault == 'misaligned': r['samples'][1]['sensor_timestamp'] += .01
    if fault == 'synthetic': r['synthetic'] = True
    if fault == 'empty': r['samples'] = []
    if fault == 'unknown': r['private_sensor'] = 1
    if fault == 'device': r['device'] = 'different-device'
    if fault == 'duration': r['requested_duration_s'] = 1
    assert client.post('/api/v1/recordings', json=r, headers=auth).status_code == 422


def test_conflicting_retry(client, auth):
    session, r, _ = upload(client, auth)
    r['label'] = 'Different phrase'
    assert client.post('/api/v1/recordings', json=r, headers=auth).status_code == 409
    session['experiment'] = 'Changed'
    assert client.post('/api/v1/sessions', json=session, headers=auth).status_code == 409


def test_size_and_rate_limits(client, auth, monkeypatch):
    monkeypatch.setattr(settings, 'max_upload_bytes', 10)
    assert client.post('/api/v1/recordings', content=b'a' * 11, headers=auth).status_code == 413
    monkeypatch.setattr(settings, 'rate_limit_per_minute', 2)
    buckets.clear()
    assert client.get('/api/v1/me', headers=auth).status_code == 200
    assert client.get('/api/v1/me', headers=auth).status_code == 200
    assert client.get('/api/v1/me', headers=auth).status_code == 429


def test_nonfinite_measurement_rejected(client, auth):
    s, r = fixture_data()
    client.post('/api/v1/sessions', json=s, headers=auth)
    r['samples'][1]['user_acceleration'] = {'x': 'NaN', 'y': 0, 'z': 0}
    assert client.post('/api/v1/recordings', json=r, headers=auth).status_code == 422
