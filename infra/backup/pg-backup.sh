#!/usr/bin/env bash
# N409 PostgreSQL backup (audit P0-1).
#
# Takes a compressed, self-contained pg_dump of the N409 database, writes it into
# a dated file under a daily backup directory, promotes one dump per week into a
# weekly directory, and prunes both directories to a bounded retention window
# (7 daily + 4 weekly by default). Designed to be driven by n409-backup.timer,
# but is safe to run by hand at any time.
#
# Restore procedure: see infra/backup/README.md (and pg-restore.sh).
#
# Configuration (all overridable via the environment — the systemd unit and the
# tests both rely on this):
#   DATABASE_URL   Postgres connection string. If unset, sourced from ENV_FILE.
#   ENV_FILE       File to read DATABASE_URL from (default /opt/N409/.env).
#   BACKUP_ROOT    Root backup directory (default /opt/n409-backups).
#   KEEP_DAILY     Number of daily dumps to retain (default 7).
#   KEEP_WEEKLY    Number of weekly dumps to retain (default 4).
#   WEEKLY_DOW     ISO day-of-week (1=Mon..7=Sun) to promote to weekly (default 7).
#   PG_DUMP        pg_dump binary/command to use (default "pg_dump"). Tests stub this.
#   BACKUP_DATE    Override the timestamp used in filenames (for deterministic
#                  tests). Format: YYYYMMDD-HHMMSS.
#   BACKUP_DOW     Override the ISO day-of-week (for deterministic tests).
#
# Exit codes: 0 success, non-zero on any failure (set -e). The dump is written to
# a temp file and atomically renamed, so a partial/failed dump never leaves a
# truncated file that could later be promoted or restored.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/N409/.env}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/n409-backups}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
WEEKLY_DOW="${WEEKLY_DOW:-7}"
PG_DUMP="${PG_DUMP:-pg_dump}"

log() { printf '%s n409-backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '?')" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Resolve DATABASE_URL: explicit env wins, otherwise read it out of ENV_FILE
# without sourcing the whole file (which may contain other secrets/side effects).
if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ -r "$ENV_FILE" ]]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
    # Strip optional surrounding quotes.
    DATABASE_URL="${DATABASE_URL%\"}"; DATABASE_URL="${DATABASE_URL#\"}"
    DATABASE_URL="${DATABASE_URL%\'}"; DATABASE_URL="${DATABASE_URL#\'}"
  fi
fi
[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL not set and not found in $ENV_FILE"

DATE="${BACKUP_DATE:-$(date -u +%Y%m%d-%H%M%S)}"
DOW="${BACKUP_DOW:-$(date -u +%u)}"

DAILY_DIR="$BACKUP_ROOT/daily"
WEEKLY_DIR="$BACKUP_ROOT/weekly"
mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"

DEST="$DAILY_DIR/n409-$DATE.dump"
TMP="$DEST.partial"

# Custom format (-Fc): compressed, restored with pg_restore, resilient to schema
# reordering. --no-owner/--no-acl keep the dump portable across roles.
log "dumping database to $DEST"
"$PG_DUMP" --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file="$TMP"
[[ -s "$TMP" ]] || die "dump produced an empty file"
mv -f "$TMP" "$DEST"
log "wrote $(wc -c <"$DEST" 2>/dev/null || echo '?') bytes"

# Promote to the weekly set once per week.
if [[ "$DOW" == "$WEEKLY_DOW" ]]; then
  cp -f "$DEST" "$WEEKLY_DIR/n409-$DATE.dump"
  log "promoted to weekly"
fi

# Prune: keep only the newest N dumps in each directory. Sorting by filename is
# equivalent to sorting by time because the timestamp prefix is lexicographic.
prune() {
  local dir="$1" keep="$2" f count=0
  # List newest first; delete everything past the keep-th entry.
  while IFS= read -r f; do
    count=$((count + 1))
    if (( count > keep )); then
      rm -f -- "$f"
      log "pruned $(basename "$f")"
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name 'n409-*.dump' | sort -r)
}
prune "$DAILY_DIR" "$KEEP_DAILY"
prune "$WEEKLY_DIR" "$KEEP_WEEKLY"

log "done (daily=$(find "$DAILY_DIR" -name 'n409-*.dump' | wc -l | tr -d ' '), weekly=$(find "$WEEKLY_DIR" -name 'n409-*.dump' | wc -l | tr -d ' '))"
