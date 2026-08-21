# N409 database backups & restore (audit P0-1)

Automated nightly PostgreSQL backups with rotation, plus a documented, tested
restore procedure. This closes audit finding **P0-1** (no automated backups /
no restore runbook).

## What runs

| File | Role |
| --- | --- |
| `pg-backup.sh` | Dumps the DB (`pg_dump -Fc`), verifies the archive, records a checksum, promotes a weekly copy, prunes to retention. |
| `pg-verify.sh` | Proves a dump **restores**, by restoring it into a scratch database. `--quick` re-checks archives and checksums only. |
| `pg-restore.sh` | Restores a dump into a target DB (interactive confirm; `FORCE=1` to skip). |
| `n409-backup.service` | Oneshot unit that runs `pg-backup.sh` as the `n409` user. |
| `n409-backup.timer` | Fires the service nightly at **02:00** (`Persistent=true`). |
| `n409-backup-verify.service` | Oneshot unit that runs `pg-verify.sh`. |
| `n409-backup-verify.timer` | Fires the verification weekly, **Sunday 04:00** — after the nightly dump and its weekly promotion. |

Backups land under **`/opt/n409-backups`** on the host:

```
/opt/n409-backups/
  daily/   n409-YYYYMMDD-HHMMSS.dump          # kept: 7 newest  (KEEP_DAILY)
           n409-YYYYMMDD-HHMMSS.dump.sha256   # checksum, written with the dump
  weekly/  n409-YYYYMMDD-HHMMSS.dump          # kept: 4 newest  (KEEP_WEEKLY)
           n409-YYYYMMDD-HHMMSS.dump.sha256
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
| `MIN_TOC_ENTRIES` | `10` | Floor on the dump's table-of-contents entry count. |

## Three checks, three strengths

These are deliberately different claims, and only the last one is evidence:

1. **Every dump, every night** — `pg-backup.sh` reads the archive's table of
   contents back with `pg_restore --list` before rotating it in, and floors the
   entry count. A dump truncated by a full disk is non-empty, so it passed the
   old `[[ -s ]]` check; it fails this one. A dump of an empty scratch database
   is a valid archive; the entry floor is what catches it. A dump that fails
   verification is deleted and **not** rotated in — it never evicts a good one.
2. **Every dump, on demand** — `pg-verify.sh --quick` re-reads every archive in
   the retention window and checks it against the SHA-256 recorded when it was
   written. This catches bit-rot and truncated copies *after* the fact. Seconds,
   no server needed.
3. **The newest dump, weekly** — `pg-verify.sh` restores into a scratch
   database, counts the tables, reads each spine table, and checks the migration
   ledger is non-empty, then drops the scratch DB. This is the only check that
   proves a restore works rather than inferring it.

```bash
sudo /opt/N409/infra/backup/pg-verify.sh --quick   # checksums + archives
sudo /opt/N409/infra/backup/pg-verify.sh           # full restore rehearsal
journalctl -u n409-backup-verify.service --no-pager
```

A non-zero exit from either mode is worth a page: a backup that does not
restore is indistinguishable from no backup.

## Install on the host

```bash
# Files ship in the repo at /opt/N409/infra/backup and are symlinked/copied in.
sudo cp /opt/N409/infra/backup/n409-backup.service /etc/systemd/system/
sudo cp /opt/N409/infra/backup/n409-backup.timer   /etc/systemd/system/
sudo cp /opt/N409/infra/backup/n409-backup-verify.service /etc/systemd/system/
sudo cp /opt/N409/infra/backup/n409-backup-verify.timer   /etc/systemd/system/
sudo install -d -o n409 -g n409 /opt/n409-backups
sudo systemctl daemon-reload
sudo systemctl enable --now n409-backup.timer
sudo systemctl enable --now n409-backup-verify.timer
```

Only the **timers** are enabled. The two `.service` units are triggered by them
and are meant to stay disabled; `n409-backup-verify.service` has no `[Install]`
section at all, so `systemctl enable` on it refuses rather than scheduling a full
restore at every boot.

### The verification credential

`n409-backup-verify.service` needs a second env file, kept outside the repository
because it holds a password. **Run this on the database host:**

```bash
sudo infra/backup/provision-verify-role.sh
```

It creates the role with a generated password, writes
`/etc/n409/backup-verify.env` (0640 root:n409), and then *connects as that role*
to confirm it can `CREATE DATABASE` before reporting success — because "the
statements did not error" is not the same as "the rehearsal will work on Sunday".

It is idempotent and safe to re-run: a host whose existing credential connects
and has `CREATEDB` is left alone, and one whose credential is missing, stale, or
lacking the privilege is re-provisioned. To rotate, delete the env file and run
it again.

This was done by hand in R87 and recorded nowhere but a shell history, which is
why it is a script now: a rebuilt host came up with the timer armed, the unit
refusing to start on a missing `EnvironmentFile`, and nothing anywhere saying
what belonged in it.

The restore creates a scratch database, which needs `CREATE DATABASE`. The
application role does not have that privilege and should not gain it — it is the
credential the internet-facing service holds, and widening it so a weekly
maintenance job can run is the wrong trade. `n409_verify` has `LOGIN` and
`CREATEDB` and nothing else: no ownership of any application object, no grants on
the application database. `pg_restore --no-owner --no-acl` means it never needs
any, and restoring with a credential that is not the application's is closer to
the situation the job rehearses.

The unit lists this file *after* `/opt/N409/.env`, because that is what makes its
`DATABASE_URL` win. Without the `-` prefix, so a host missing the file fails to
start with the reason named, rather than falling through to the application URL
and reporting `permission denied to create database` every Sunday — which reads
like a broken backup rather than a missing credential.

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
end with a stubbed `pg_dump` and `pg_restore`: it drives many simulated days
through the script and asserts the daily cap, weekly promotion on `WEEKLY_DOW`,
the weekly cap, that only the newest dumps survive, that an unreadable or
suspiciously-empty dump is refused rather than rotated in, and that each
checksum manifest is written, promoted and pruned with its dump.

`src/packages/shared/test/pg-verify.test.ts` covers the verification script with
both binaries stubbed and logging every invocation, so the assertions are about
what it did: which scratch database it created and dropped (including after a
failure), that it never connects to the live database, that connection
parameters survive the URL rewrite, and that each failure mode — an
unrestorable dump, too few tables, a missing spine table, an unmigrated
database, a stale checksum — is reported rather than passed over.

Both run in CI via `npm test`.
