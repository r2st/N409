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
#   PG_RESTORE     pg_restore binary/command, used to verify the dump's table of
#                  contents (default "pg_restore"). Tests stub this.
#   MIN_TOC_ENTRIES Minimum table-of-contents entries a dump must contain
#                  (default 10). See the verification note below.
#   BACKUP_DATE    Override the timestamp used in filenames (for deterministic
#                  tests). Format: YYYYMMDD-HHMMSS.
#   BACKUP_DOW     Override the ISO day-of-week (for deterministic tests).
#
# Exit codes: 0 success, non-zero on any failure (set -e). The dump is written to
# a temp file and atomically renamed, so a partial/failed dump never leaves a
# truncated file that could later be promoted or restored.
#
# ── On verification ──────────────────────────────────────────────────────────
#
# The only check this script used to make was that the dump file was non-empty
# (`[[ -s ]]`), and a one-byte file passes that. So did a dump killed halfway
# through by an OOM or a full disk: pg_dump writes as it goes, the file is very
# much non-empty, and the failure is discovered at the only moment it cannot be
# fixed — during a restore, at which point the good copies have long since been
# rotated out by the retention window this script also enforces.
#
# Two checks now, at two different costs:
#
#   * every run reads the archive's table of contents back (`pg_restore -l`).
#     That parses the header and the whole TOC, so a truncated or corrupt
#     archive fails here rather than in six weeks. It is cheap — no server
#     involved, no data decompressed — and it is the difference between "a file
#     exists" and "a file pg_restore can read".
#   * the entry count is floored, because a technically-valid archive of the
#     *wrong database* is the other way this goes quietly wrong: point
#     DATABASE_URL at an empty scratch DB and you get a perfectly well-formed
#     dump of nothing at all, rotated into the same directory as the real ones.
#
# Neither proves the dump restores. Only a restore proves that, which is what
# pg-verify.sh does on its own schedule — see infra/backup/README.md.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/N409/.env}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/n409-backups}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
WEEKLY_DOW="${WEEKLY_DOW:-7}"
PG_DUMP="${PG_DUMP:-pg_dump}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"
MIN_TOC_ENTRIES="${MIN_TOC_ENTRIES:-10}"

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

# Read the archive back before it is allowed to become a backup. Verified on the
# temp file, which is removed on failure below, so a dump that fails here never
# enters the rotation — where its only effect would be to evict a good one.
verify_toc() {
  local file="$1" toc entries
  if ! toc="$("$PG_RESTORE" --list "$file" 2>&1)"; then
    log "pg_restore --list failed: $toc"
    return 1
  fi
  # TOC lines are `id; oid oid TYPE schema name owner`; comments start with ';'.
  entries="$(printf '%s\n' "$toc" | grep -cE '^[0-9]+;' || true)"
  log "table of contents: $entries entries"
  if (( entries < MIN_TOC_ENTRIES )); then
    log "only $entries TOC entries (expected at least $MIN_TOC_ENTRIES) — this looks like a dump of the wrong or an empty database"
    return 1
  fi
  return 0
}

if ! verify_toc "$TMP"; then
  rm -f -- "$TMP"
  die "dump failed verification; not rotating it in"
fi

mv -f "$TMP" "$DEST"

# A checksum recorded at the moment the dump was known good, so bit-rot or a
# truncated copy is detectable later without a database. `pg-verify.sh --quick`
# is what re-reads these; `sha256sum -c` works by hand from the same file.
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$DAILY_DIR" && sha256sum "$(basename "$DEST")" > "$(basename "$DEST").sha256" )
elif command -v shasum >/dev/null 2>&1; then
  ( cd "$DAILY_DIR" && shasum -a 256 "$(basename "$DEST")" > "$(basename "$DEST").sha256" )
else
  log "no sha256sum/shasum available — skipping checksum manifest"
fi

log "wrote $(wc -c <"$DEST" 2>/dev/null || echo '?') bytes"

# Promote to the weekly set once per week.
if [[ "$DOW" == "$WEEKLY_DOW" ]]; then
  cp -f "$DEST" "$WEEKLY_DIR/n409-$DATE.dump"
  # The checksum travels with the copy. A weekly dump with no manifest would be
  # the one that is kept longest and verifiable least, which is backwards.
  [[ -f "$DEST.sha256" ]] && cp -f "$DEST.sha256" "$WEEKLY_DIR/n409-$DATE.dump.sha256"
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
      # The checksum manifest goes with its dump. Pruning only the .dump would
      # leave the .sha256 behind forever — the retention window bounds the
      # directory by design, and an orphan class that nothing deletes is an
      # unbounded one hiding inside it.
      rm -f -- "$f" "$f.sha256"
      log "pruned $(basename "$f")"
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name 'n409-*.dump' | sort -r)
}
prune "$DAILY_DIR" "$KEEP_DAILY"
prune "$WEEKLY_DIR" "$KEEP_WEEKLY"

log "done (daily=$(find "$DAILY_DIR" -name 'n409-*.dump' | wc -l | tr -d ' '), weekly=$(find "$WEEKLY_DIR" -name 'n409-*.dump' | wc -l | tr -d ' '))"
