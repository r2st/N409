#!/usr/bin/env bash
# N409 PostgreSQL restore helper (audit P0-1).
#
# Restores a pg_dump custom-format file produced by pg-backup.sh back into a
# database. This is deliberately explicit and interactive-by-default because a
# restore is destructive: it drops and recreates the objects in the target DB.
#
# Usage:
#   pg-restore.sh <dump-file> [target-database-url]
#
# If the target URL is omitted it is resolved the same way pg-backup.sh resolves
# it (DATABASE_URL env, else DATABASE_URL= line in ENV_FILE, default /opt/N409/.env).
#
# Examples:
#   # Restore the newest daily backup into the live DB (asks for confirmation):
#   sudo ./pg-restore.sh "$(ls -1t /opt/n409-backups/daily/*.dump | head -1)"
#
#   # Restore into a scratch DB to verify a backup without touching prod:
#   createdb n409_restore_check
#   ./pg-restore.sh /opt/n409-backups/daily/n409-20260721-020000.dump \
#     postgres://n409:PASS@localhost:5432/n409_restore_check
#
# Set FORCE=1 to skip the confirmation prompt (used by automated restore tests).
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/N409/.env}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"

DUMP="${1:-}"
[[ -n "$DUMP" && -r "$DUMP" ]] || { echo "usage: $0 <dump-file> [target-database-url]" >&2; exit 2; }

TARGET="${2:-${DATABASE_URL:-}}"
if [[ -z "$TARGET" && -r "$ENV_FILE" ]]; then
  TARGET="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  TARGET="${TARGET%\"}"; TARGET="${TARGET#\"}"; TARGET="${TARGET%\'}"; TARGET="${TARGET#\'}"
fi
[[ -n "$TARGET" ]] || { echo "no target database URL (arg 2, DATABASE_URL, or $ENV_FILE)" >&2; exit 2; }

# Redact credentials when echoing the target.
REDACTED="$(printf '%s' "$TARGET" | sed -E 's#://[^@]*@#://***:***@#')"
echo "About to restore:"
echo "  from: $DUMP"
echo "  into: $REDACTED"
echo "This will DROP and recreate objects in the target database."

if [[ "${FORCE:-0}" != "1" ]]; then
  read -r -p "Type 'yes' to continue: " ans
  [[ "$ans" == "yes" ]] || { echo "aborted"; exit 1; }
fi

# --clean --if-exists drops existing objects first; --no-owner/--no-acl match the
# dump flags. Single transaction so a failure rolls back cleanly.
"$PG_RESTORE" --dbname="$TARGET" --clean --if-exists --no-owner --no-acl --single-transaction "$DUMP"
echo "restore complete"
