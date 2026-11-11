#!/usr/bin/env bash
# Consistent DB/files snapshot; briefly stop ingestion during the snapshot.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
backup_root="${BACKUP_DIR:-$PWD/backups}"
mkdir -p "$backup_root"
exec 9>"$backup_root/.backup.lock"
flock -n 9 || exit 0
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$backup_root/$stamp"
docker compose stop api
trap 'docker compose start api >/dev/null' EXIT
docker compose exec -T db pg_dump -U silentlink -d silentlink -Fc > "$backup_root/$stamp/database.dump"
docker compose run --rm -T --no-deps api tar -C /data/recordings -czf - . > "$backup_root/$stamp/recordings.tar.gz"
sha256sum "$backup_root/$stamp/database.dump" "$backup_root/$stamp/recordings.tar.gz" > "$backup_root/$stamp/SHA256SUMS"
printf 'Backup complete: %s\n' "$backup_root/$stamp"
# Delete only backups created by this script, after 14 days.
find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' -mtime +14 -exec rm -rf -- {} +
