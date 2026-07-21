# N409 database backups & restore (audit P0-1)

Automated nightly PostgreSQL backups with rotation, plus a documented, tested
restore procedure. This closes audit finding **P0-1** (no automated backups /
no restore runbook).

## What runs

| File | Role |
| --- | --- |
| `pg-backup.sh` | Dumps the DB (`pg_dump -Fc`), promotes a weekly copy, prunes to retention. |
| `pg-restore.sh` | Restores a dump into a target DB (interactive confirm; `FORCE=1` to skip). |
| `n409-backup.service` | Oneshot unit that runs `pg-backup.sh` as the `n409` user. |
| `n409-backup.timer` | Fires the service nightly at **02:00** (`Persistent=true`). |

Backups land under **`/opt/n409-backups`** on the host:

```
/opt/n409-backups/
  daily/   n409-YYYYMMDD-HHMMSS.dump   # kept: 7 newest  (KEEP_DAILY)
  weekly/  n409-YYYYMMDD-HHMMSS.dump   # kept: 4 newest  (KEEP_WEEKLY)
```

A dump taken on Sunday (ISO day-of-week 7, `WEEKLY_DOW`) is additionally copied
into `weekly/`. Retention is enforced every run, so the two directories never
grow past 7 + 4 files. Dumps are custom-format, compressed, and `--no-owner
--no-acl` so they restore cleanly across roles.

## Configuration

All knobs are environment variables (see the header of `pg-backup.sh`).
Defaults are production-correct; the systemd unit sets `BACKUP_ROOT` and reads
`DATABASE_URL` from `/opt/N409/.env`.

| Var | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | from `/opt/N409/.env` | Connection string to dump. |
| `BACKUP_ROOT` | `/opt/n409-backups` | Root of `daily/` and `weekly/`. |
| `KEEP_DAILY` | `7` | Daily dumps retained. |
| `KEEP_WEEKLY` | `4` | Weekly dumps retained. |
| `WEEKLY_DOW` | `7` (Sun) | ISO day-of-week promoted to weekly. |

## Install on the host

```bash
# Files ship in the repo at /opt/N409/infra/backup and are symlinked/copied in.
sudo cp /opt/N409/infra/backup/n409-backup.service /etc/systemd/system/
sudo cp /opt/N409/infra/backup/n409-backup.timer   /etc/systemd/system/
sudo install -d -o n409 -g n409 /opt/n409-backups
sudo systemctl daemon-reload
sudo systemctl enable --now n409-backup.timer
```

Check the schedule and run one on demand:

```bash
systemctl list-timers n409-backup.timer      # next/last fire time
sudo systemctl start n409-backup.service     # run a backup now
journalctl -u n409-backup.service --no-pager # see the last run's log
```

## Restore procedure

> A restore is **destructive** to the target database. Always confirm the target
> URL before proceeding. To rehearse safely, restore into a scratch database
> first (see below) — do this periodically to prove the backups are good.

**1. Pick a dump.** Newest daily:

```bash
ls -1t /opt/n409-backups/daily/*.dump | head
```

**2a. Verify a backup without touching prod (recommended cadence: monthly):**

Run this as `root` (or the `n409` user) so the process can read the dump —
`/opt/n409-backups` is mode `750`, so the `postgres` OS user cannot traverse it.
Create the scratch DB owned by the `n409` role so the restore has privileges:

```bash
sudo -u postgres createdb -O n409 n409_restore_check
sudo FORCE=1 /opt/N409/infra/backup/pg-restore.sh \
  /opt/n409-backups/daily/n409-YYYYMMDD-HHMMSS.dump \
  postgres://n409:PASS@localhost:5432/n409_restore_check
# spot-check row counts, e.g.:
sudo -u postgres psql -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" \
  n409_restore_check
sudo -u postgres dropdb n409_restore_check
```

This exact rehearsal was run at deploy time and passed (77 public tables
restored, matching live).

**2b. Restore into the live database (disaster recovery):**

```bash
sudo systemctl stop 'n409-*.service'         # quiesce writers first
./pg-restore.sh /opt/n409-backups/daily/n409-YYYYMMDD-HHMMSS.dump
sudo systemctl start 'n409-*.service'
```

`pg-restore.sh` uses `pg_restore --clean --if-exists --no-owner --no-acl
--single-transaction`, so it drops existing objects and restores atomically —
a failure rolls back and leaves the target untouched. Set `FORCE=1` to skip the
interactive prompt in automation.

## Off-host copies

`/opt/n409-backups` lives on the same VPS as the database, so it survives a bad
deploy or an accidental `DROP` but **not** loss of the host. For true DR, sync
the directory off-box (e.g. nightly `rclone`/`rsync` to object storage) — see
the DR section of `infra/DEPLOYMENT.md`.

## Tests

`src/packages/shared/test/pg-backup.test.ts` exercises the rotation logic end to
end with a stubbed `pg_dump`: it drives many simulated days through the script
and asserts the daily cap, weekly promotion on `WEEKLY_DOW`, the weekly cap, and
that only the newest dumps survive. Runs in CI via `npm test`.
