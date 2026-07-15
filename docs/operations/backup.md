# Backup and recovery

The backup job packages the control-plane state directory, including its token store for session recovery, authenticates and encrypts the package with AES-256-GCM, and sends it to a mounted or rsync-accessible off-host directory. The encrypted `snapshot.enc` remains opaque inside that package. SQLite databases are copied with SQLite's online `.backup` API, never by copying a live database file.

## Configuration and schedule

Install `deploy/systemd/vw-backup.service` and `vw-backup.timer`, then place configuration in `/etc/vaultwarden-secrets/backup.env`. The timer runs daily with up to 15 minutes of jitter as the unprivileged `vwsecrets` service user (the same identity created by the hardened runtime envelope; provisioning of that user and its `bun` at `/usr/local/bin` is owned by `docs/runtime/envelope.md`). The unit declares `HOME` and `PATH` because systemd does not inherit an interactive shell environment.

```text
VW_STATE_DIR=/var/lib/vaultwarden-secrets/state
VW_BACKUP_KEY_FILE=/var/lib/vaultwarden-secrets/backup.key
VW_BACKUP_DEST=backup@backup-host:/srv/backups/vaultwarden-secrets
VW_BACKUP_RETAIN_DAYS=30
VW_BACKUP_MAX_AGE_HOURS=24
VW_BACKUP_RECEIPTS_DIR=/var/lib/vaultwarden-secrets/receipts
```

`VW_BACKUP_DEST` may instead be a mounted directory. Remote destinations use `user@host:/absolute/path`; `rsync` transports backups and SSH performs narrowly-patterned retention and health checks. Configure host-key verification and non-interactive SSH credentials for the service account before enabling the timer.

Create a 32-byte key using a local cryptographic random generator. The key file may contain 32 raw bytes, 64 hexadecimal characters, or base64 for exactly 32 bytes. It must be readable by the service account, mode `0600` or `0640`, and must not be world-readable. Store a recovery copy separately from both the source host and backup destination. Never put the key or secret values in the environment file or repository.

The embedded manifest records the UTC creation time, source hostname, regular-file list, sizes, and SHA-256 checksums. A second manifest records only relevant environment variable names; it never records their values. Backup files are mode `0600` and named `vw-state-YYYYMMDDTHHMMSSZ.tar.enc`. Retention deletes only files matching that exact naming pattern. The default is 30 days.

Enable and inspect the schedule:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now vw-backup.timer
systemctl list-timers vw-backup.timer
```

## Exit-code contract and health wiring

All three scripts return `0` only after their complete contract succeeds and `1` for configuration, transport, encryption/decryption, freshness, checksum, SQLite-integrity, receipt, or retention failure. They print one concise healthy line to stdout on success and an unhealthy/failed line to stderr on failure. No secret values are printed.

Wire `bun run scripts/backup-health.ts` into cron, a systemd health timer, or the monitoring agent. It selects the newest correctly named backup, fails closed when none exists or it is older than `VW_BACKUP_MAX_AGE_HOURS` (default 24), downloads it when the destination is remote, then verifies AES-GCM authentication and every manifest checksum. Alert on a nonzero exit code or the `backup unhealthy:` prefix.

## Isolated restore drill

Run at least monthly and after backup-format or state-schema changes:

```sh
bun run scripts/restore-drill.ts /mnt/offhost/vw-state-YYYYMMDDTHHMMSSZ.tar.enc \
  --target /var/tmp/vw-restore-drill-YYYYMMDD \
  --receipts-dir /var/lib/vaultwarden-secrets/receipts
```

The target must be a new, empty, isolated directory. The script refuses the live `VW_STATE_DIR`, authenticates and extracts the backup, verifies the complete manifest, runs `PRAGMA integrity_check` on every restored SQLite database, and records per-table row counts. It writes a redacted JSON receipt containing only filenames, timestamps, counts, integrity status, elapsed restore milliseconds (RTO evidence), and backup age seconds (RPO evidence). It never writes secret values.

The operational target is a recoverable backup no more than 24 hours old (RPO) and a measured isolated restore within the host-specific alert threshold established from drill receipts (RTO). Keep several receipts to detect regressions; do not claim a production RTO until a controller has timed the drill on the real recovery host and data volume.

For actual recovery, first stop the application, preserve the live state directory, complete an isolated drill, and only then copy the verified restored state into a separately approved recovery location. The drill command itself intentionally cannot overwrite production.
