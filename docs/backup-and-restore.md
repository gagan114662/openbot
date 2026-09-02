# Database backup and restore

OpenBot ships a streaming PostgreSQL backup, an executed restore drill, and a systemd schedule. A
backup is not complete until both the `.dump` and its checksum manifest exist off the database host.

Configure `/etc/openbot/backup.env` with mode `0600`:

```dotenv
DATABASE_URL=postgres://openbot:...@database.internal:5432/openbot
OPENBOT_BACKUP_DIR=/var/backups/openbot
OPENBOT_BACKUP_OFFSITE_URI=s3://company-openbot-backups/production
OPENBOT_BACKUP_RETENTION_DAYS=30
AWS_REGION=ca-central-1
```

Cloudflare R2 is also supported through the authenticated Wrangler CLI. Use an explicit `r2://`
URI so the transport is never confused with AWS, for example:

```dotenv
OPENBOT_BACKUP_OFFSITE_URI=r2://company-openbot-backups/production
```

Both transports upload the dump and manifest, download each object into a private temporary
directory, and compare SHA-256 hashes before the backup command reports success. Install either the
AWS CLI with workload credentials or Wrangler with an account token that can write the named R2
bucket on the backup host.

The host or workload identity must have write-only access to that prefix. Do not put static cloud
keys in the repository. Install `ops/systemd/openbot-backup.{service,timer}`, run
`systemctl enable --now openbot-backup.timer`, and alert when the timer or service fails. The timer
runs every six hours, catches up after downtime, forbids overlap through systemd's one-unit rule,
and retains 30 days locally by default. Configure the bucket lifecycle independently: 35 days in
standard storage, then 365 days in archive storage is the deployment baseline.

Run a restore drill at least monthly and after every PostgreSQL major-version change:

```sh
bun server/scripts/database-backup.ts drill /var/backups/openbot/openbot-<timestamp>.dump
```

The drill creates a uniquely named disposable database, restores with `--exit-on-error`, verifies
users, credentials and audit rows through the application schema, and drops the database even when
verification fails. CI executes this create → restore → verify path against its PostgreSQL service;
the test does not inspect source text.
