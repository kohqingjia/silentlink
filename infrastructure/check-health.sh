#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! docker compose exec -T api python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=5)"; then
    logger -t silentlink 'API health check failed; inspect docker compose logs'
    exit 1
fi
if ! docker compose exec -T vision python -c "import json,urllib.request; status=json.load(urllib.request.urlopen('http://localhost:8000/api/vision/status', timeout=5)); assert status['ready'], status['stage']"; then
    logger -t silentlink 'Camera model is not ready; inspect docker compose logs vision'
    exit 1
fi
