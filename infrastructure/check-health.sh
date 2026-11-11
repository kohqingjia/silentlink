#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! docker compose exec -T api python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=5)"; then
    logger -t silentlink 'API health check failed; inspect docker compose logs'
    exit 1
fi
