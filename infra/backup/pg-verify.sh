#!/usr/bin/env bash
# N409 backup verification — does the newest dump actually restore?
#
# `pg-backup.sh` proves a dump is a well-formed archive with a plausible table
# of contents. That is worth having and it is not the same claim as "we can
# recover from this". An archive can pass its TOC read and still fail to restore
# — a partially-written data block past the header, a compression error in one
# large object, a dump taken against a server whose extensions are absent on the
# machine you are restoring to. Every one of those is discovered during a
# restore, and if the first restore anyone attempts is the one during the
# incident, the backup strategy was never tested; it was only ever assumed.
#
# So this restores the newest dump into a scratch database, asks it some
# questions, and drops it. It is the only check in this directory that produces
# evidence rather than inference.
#
# Two modes:
#
#   --quick   Re-read the archive TOC and check the recorded SHA-256 of every
#             dump in the retention window. No server, no restore. Catches
#             on-disk corruption of dumps that were good when written. Seconds.
#
#   (default) The full thing: create a scratch database, restore into it, run
#             the sanity queries below, drop it. Minutes, and it needs a server
#             it is allowed to CREATE DATABASE on.
#
# Usage:
#   pg-verify.sh [--quick] [dump-file]
#
# With no dump-file the newest file under $BACKUP_ROOT/daily is used.
#
# Configuration:
#   DATABASE_URL     Server to restore into. Resolved from ENV_FILE if unset.
#                    The *database* in this URL is never touched — only the
#                    server is borrowed, and a scratch database is created on it.
#   ENV_FILE         Default /opt/N409/.env.
#   BACKUP_ROOT      Default /opt/n409-backups.
#   VERIFY_DB        Scratch database name. Default n409_verify_<pid>.
#   MIN_TABLES       Minimum tables the restored schema must contain. Default 40.
#   REQUIRED_TABLES  Space-separated tables that must exist and be queryable.
#   PG_RESTORE/PSQL  Binaries; the tests stub these.
#   SHA256           Digest command for --quick, resolved from sha256sum or
#                    shasum -a 256 when unset; the tests stub it.
#   KEEP_SCRATCH=1   Leave the scratch database behind for inspection.
#   FLAG_BACKUP_VERIFICATION
#                    Kill switch. Off (0/false/no/off/disabled) skips both modes
#                    and exits 0 with a SKIPPED line. Unset means on. See the
#                    block below the argument parsing for why 0 and not 1.
#
# Exit codes: 0 verified — or deliberately skipped, see FLAG_BACKUP_VERIFICATION
# — 1 verification failed, 2 usage/configuration error.
# Non-zero is a page: a backup that does not restore is indistinguishable from
# no backup, and it is worth knowing on a Tuesday rather than during an outage.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/N409/.env}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/n409-backups}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"
PSQL="${PSQL:-psql}"
MIN_TABLES="${MIN_TABLES:-40}"
# The spine of the schema. If a restore comes back without these, whatever it
# produced is not this application's database, however many tables it has.
REQUIRED_TABLES="${REQUIRED_TABLES:-valuations users valuation_params calculations schema_migrations}"

log() { printf '%s n409-verify: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '?')" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

QUICK=0
DUMP=""
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) DUMP="$arg" ;;
  esac
done

# ── The kill switch ──────────────────────────────────────────────────────────
#
# FLAG_BACKUP_VERIFICATION=off, read from /opt/N409/.env via the unit's
# EnvironmentFile, same variable and same accepted spellings as the TypeScript
# registry in src/packages/shared/src/flags.ts. Unset means on, because this
# verification is already running in production and a flag that defaulted off
# would silently stop it on the deploy that introduced the flag.
#
# The narrow reason to throw it: the restore is the one job here that competes
# for disk and IO on the same host as the database, and it is the only thing in
# this directory that can be dropped without losing data. `n409-backup.timer` is
# untouched, so dumps keep being taken — they just stop being proven.
#
# Exits 0. That is a deliberate and slightly uncomfortable choice: 0 otherwise
# means "verified", and this run verified nothing. Exit 1 was the alternative
# and it is worse, because it pages somebody for a decision an operator made on
# purpose, and a job that pages on its own configuration is a job that gets
# masked entirely — taking the real failures with it. The SKIPPED line is
# therefore written to be greppable, and it says plainly that nothing was
# checked, so a log reader is never told a backup was verified when it was not.
flag_off() {
  case "$(printf '%s' "${FLAG_BACKUP_VERIFICATION:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    0 | false | no | off | disabled) return 0 ;;
    *) return 1 ;;
  esac
}

if flag_off; then
  log "SKIPPED: FLAG_BACKUP_VERIFICATION=${FLAG_BACKUP_VERIFICATION} — nothing was restored and nothing was verified"
  exit 0
fi

# ── Quick mode: checksums + TOC, no server ───────────────────────────────────

# Resolved once, so a host with no digest tool is one line at the top rather
# than a discovery made silently per file. Overridable for the same reason
# PG_RESTORE and PSQL are.
if [[ -z "${SHA256:-}" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then SHA256="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then SHA256="shasum -a 256"
  fi
fi

sha_of() {
  [[ -n "${SHA256:-}" ]] || return 2
  # shellcheck disable=SC2086 — SHA256 may carry its own flags ("shasum -a 256").
  $SHA256 "$1" | cut -d' ' -f1
}

if (( QUICK )); then
  checked=0; failed=0; unmanifested=0; undigested=0
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    checked=$((checked + 1))
    if ! "$PG_RESTORE" --list "$f" >/dev/null 2>&1; then
      log "FAIL $(basename "$f"): archive is unreadable"
      failed=$((failed + 1))
      continue
    fi
    if [[ -f "$f.sha256" ]]; then
      recorded="$(cut -d' ' -f1 <"$f.sha256")"
      # A COMPARISON THAT COULD NOT BE MADE IS NOT A COMPARISON THAT PASSED
      # (round 397, methodology M11).
      #
      # `if actual="$(sha_of "$f")"; then` had no else. Every way of failing to
      # compute the digest — no sha256sum and no shasum on the host, a read
      # error partway through a dump on a disk that is going, a pipefail out of
      # the `cut` — fell out of the `if` and straight into the `log "ok"` at the
      # bottom of the loop, and the summary counted the file as checked. The
      # one thing this script exists to be is trustworthy about which dumps
      # were verified, and this is the branch where it said "ok" having
      # verified nothing but that pg_restore could list the archive.
      #
      # Counted separately rather than failed: the archive *was* read, so this
      # is neither a good dump nor a bad one, it is an unanswered question —
      # and the same argument the FLAG_BACKUP_VERIFICATION block makes applies,
      # that a job which pages over its own tooling is a job that gets masked.
      # So it is greppable, it is in the summary, and it is never "ok".
      if actual="$(sha_of "$f")"; then
        if [[ "$recorded" != "$actual" ]]; then
          log "FAIL $(basename "$f"): sha256 mismatch — the file has changed since it was written"
          failed=$((failed + 1))
          continue
        fi
      else
        if [[ -n "${SHA256:-}" ]]; then why="$SHA256 failed"; else why="no sha256sum or shasum on this host"; fi
        log "NOT CHECKED $(basename "$f"): the archive lists, but its recorded sha256 could not be recomputed — $why"
        undigested=$((undigested + 1))
        continue
      fi
    else
      # Not a failure: dumps written before checksums existed have no manifest,
      # and failing on their absence would make the first run after this change
      # page somebody about backups that are perfectly fine.
      unmanifested=$((unmanifested + 1))
    fi
    log "ok $(basename "$f")"
  done < <(find "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly" -maxdepth 1 -type f -name 'n409-*.dump' 2>/dev/null | sort -r)

  (( checked > 0 )) || die "no dumps found under $BACKUP_ROOT"
  log "quick verify: $checked checked, $failed failed, $unmanifested without a checksum manifest, $undigested with a manifest that could not be recomputed"
  (( failed == 0 )) || exit 1
  exit 0
fi

# ── Full mode: restore into a scratch database ───────────────────────────────

if [[ -z "$DUMP" ]]; then
  DUMP="$(find "$BACKUP_ROOT/daily" -maxdepth 1 -type f -name 'n409-*.dump' 2>/dev/null | sort -r | head -1)"
fi
[[ -n "$DUMP" && -r "$DUMP" ]] || die "no readable dump found (looked under $BACKUP_ROOT/daily)"

if [[ -z "${DATABASE_URL:-}" ]] && [[ -r "$ENV_FILE" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  DATABASE_URL="${DATABASE_URL%\"}"; DATABASE_URL="${DATABASE_URL#\"}"
  DATABASE_URL="${DATABASE_URL%\'}"; DATABASE_URL="${DATABASE_URL#\'}"
fi
[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL not set and not found in $ENV_FILE"

VERIFY_DB="${VERIFY_DB:-n409_verify_$$}"

# Swap the database out of the URL, keeping every connection parameter — sslmode
# and friends are frequently the difference between connecting and not, and a
# rebuilt URL that drops them fails in a way that looks like a bad backup.
target_url() {
  local db="$1"
  printf '%s' "$DATABASE_URL" | sed -E "s#(^[^?]*/)[^/?]*(\\?.*)?\$#\\1${db}\\2#"
}
ADMIN_URL="$(target_url postgres)"
SCRATCH_URL="$(target_url "$VERIFY_DB")"

cleanup() {
  local code=$?
  if [[ "${KEEP_SCRATCH:-0}" == "1" ]]; then
    log "KEEP_SCRATCH=1 — leaving $VERIFY_DB in place"
  else
    # Best effort, and deliberately not allowed to change the exit code: a
    # scratch database that outlives a failed verification is untidy, while a
    # cleanup error masking the verification's own result is misleading.
    "$PSQL" "$ADMIN_URL" -v ON_ERROR_STOP=1 -qtAc \
      "DROP DATABASE IF EXISTS \"$VERIFY_DB\" WITH (FORCE)" >/dev/null 2>&1 \
      || log "warning: could not drop scratch database $VERIFY_DB"
  fi
  exit "$code"
}
trap cleanup EXIT

log "verifying $(basename "$DUMP") by restoring into $VERIFY_DB"

"$PSQL" "$ADMIN_URL" -v ON_ERROR_STOP=1 -qtAc "CREATE DATABASE \"$VERIFY_DB\"" >/dev/null \
  || die "could not create scratch database $VERIFY_DB"

# Not --single-transaction: a fresh database has nothing to roll back to, and
# wrapping the whole restore in one transaction on a large dump is how a restore
# runs out of locks. --exit-on-error is what makes a partial restore a failure
# rather than a warning nobody reads.
if ! "$PG_RESTORE" --dbname="$SCRATCH_URL" --no-owner --no-acl --exit-on-error "$DUMP"; then
  die "pg_restore failed — this backup is NOT restorable"
fi

query() { "$PSQL" "$SCRATCH_URL" -v ON_ERROR_STOP=1 -qtAc "$1"; }

TABLES="$(query "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
TABLES="${TABLES//[[:space:]]/}"
log "restored schema has $TABLES tables in public"
[[ "$TABLES" =~ ^[0-9]+$ ]] || die "could not count tables in the restored database"
(( TABLES >= MIN_TABLES )) || die "only $TABLES tables restored (expected at least $MIN_TABLES)"

# Existence is not enough: a table can restore its definition and none of its
# data, so each one is actually read. `count(*)` on the spine of the schema is
# cheap and is the difference between "the DDL replayed" and "the data is here".
for table in $REQUIRED_TABLES; do
  if ! rows="$(query "SELECT count(*) FROM \"$table\"" 2>&1)"; then
    die "required table '$table' is missing or unreadable in the restored database: $rows"
  fi
  log "  $table: ${rows//[[:space:]]/} rows"
done

# The migration ledger is the one table whose *content* is checkable without
# knowing anything about the business data: it should be non-empty on any
# database this application has ever booted against.
MIGRATIONS="$(query "SELECT count(*) FROM schema_migrations")"
MIGRATIONS="${MIGRATIONS//[[:space:]]/}"
(( MIGRATIONS > 0 )) || die "schema_migrations is empty — the restored database has never been migrated"
log "  schema_migrations: $MIGRATIONS applied"

log "VERIFIED: $(basename "$DUMP") restores cleanly ($TABLES tables, $MIGRATIONS migrations)"
