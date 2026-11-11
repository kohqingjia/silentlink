# Deployment operations

This personal research installation uses the existing VPS Caddy proxy. Compose does not publish any host ports. Use a hostname resolving to the server and attach the API/dashboard to the proxy’s Docker network; PostgreSQL remains on a private internal network.

## Updates and rollback

```sh
cd /path/to/silentlink
git pull --ff-only
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 api
```

Before schema changes, run a backup. To roll back application code, checkout a previously tested commit and rebuild. Do not blindly downgrade a schema containing new data. Restore a matching database/files snapshot for incompatible changes. `docker compose down` preserves named volumes; never use `down -v` unless intentionally destroying the dataset.

Caddy route additions must be validated before reload. Preserve existing routes and a pre-change copy. Caddy provides HTTPS automatically. The public dashboard shell contains no recordings; every dataset request is authenticated. Header policy blocks framing and browser microphone/camera access. CSP permits inline scripts/styles required by the static Next.js export; a stricter hash-based CSP is a later hardening option.

## Backups

`infrastructure/backup.sh` creates a PostgreSQL custom-format dump and a recording-volume archive under `backups/YYYYMMDDTHHMMSSZ/`, with mode-restricted directories and SHA-256 checksums. It locks against overlap and pauses ingestion briefly so database/files snapshots agree. It resumes the API on exit and retains 14 days. Backups contain sensitive recordings and token hashes. They do not contain `.env`; preserve that separately with appropriate protection.

Example daily cron (server time):

```cron
40 3 * * * /path/to/silentlink/infrastructure/backup.sh >> /path/to/silentlink/backups/backup.log 2>&1
*/5 * * * * /path/to/silentlink/infrastructure/check-health.sh
```

Health checks report failure through the local system logger. Docker restarts crashed services and reports health; unhealthy status alone does not restart a running service. No external alert destination is configured. Add one deliberately if needed.

On-server backups do not protect against loss of the VPS. Copy encrypted backups off-host to a destination you control. No external storage account is assumed or configured.

### Restore (destructive, operator decision)

Stop ingestion first. Verify checksums and select a consistent snapshot. Restore into a **new installation/empty volumes** where possible and check the recording manifest/counts before switching traffic:

```sh
docker compose stop api
cat backups/SNAPSHOT/database.dump | docker compose exec -T db pg_restore -U silentlink -d silentlink --clean --if-exists
cat backups/SNAPSHOT/recordings.tar.gz | docker compose run --rm -T --no-deps api tar -C /data/recordings -xzf -
docker compose start api
```

Do not restore an untrusted archive. Restoring into an existing nonempty recording volume can leave unrelated files; use a fresh volume for a full restore. Restored keys from the snapshot become valid again, so reapply necessary revocations. Test restoration before relying on a backup policy.

## Storage and monitoring

Inspect `docker compose ps`, `/health`, `docker stats --no-stream`, free disk space and backup logs. Containers rotate logs at 10 MiB × 3. Storage grows with measured sample rate/duration and JSON encoding; measure actual files before estimating retention. There is no participant quota or storage-autoscaling system in this milestone.

The API and dashboard use non-root users and drop Linux capabilities. PostgreSQL uses its official container entrypoint and private network. Secrets come from untracked `.env` and separately provisioned keys. Do not store a provisioning key in GitHub Actions; CI tests/builds only and does not deploy automatically.
