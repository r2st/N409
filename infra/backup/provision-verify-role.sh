#!/usr/bin/env bash
# Provision the credential n409-backup-verify.service connects with.
#
# WHY THIS EXISTS: the weekly restore rehearsal needs CREATE DATABASE, and the
# application role does not have it and is not going to get it — that is the
# credential the internet-facing service holds. So the rehearsal connects as
# `n409_verify`, which has LOGIN and CREATEDB and nothing else.
#
# That role, and the env file naming it, were created by hand on the production
# host in R87 and existed nowhere else. Not in this repository, not in
# `deploy.sh`, not in terraform — only in a shell history and a paragraph of
# README. A rebuilt host would come up with the timer armed, the unit refusing
# to start on a missing EnvironmentFile, and nothing anywhere saying what to put
# in it. That is the same failure as the systemd drift this round closed one
# layer down: a piece of production that lives on the box and nowhere else.
#
# Idempotent by construction, so it is safe to re-run and safe to wire into a
# provisioning step. It re-provisions only when it has to:
#
#   - the env file is missing, or does not name a DATABASE_URL; or
#   - the credential it names cannot connect; or
#   - the role it names cannot CREATE DATABASE.
#
# Anything else is a host that is already correct, and it is left alone —
# rotating a working password on every run would be churn with a window in it.
#
# Run as root on the database host:
#   sudo infra/backup/provision-verify-role.sh
#
# Configuration (all overridable — the tests rely on this):
#   ROLE        Role to create (default n409_verify).
#   ENV_FILE    Where to write it (default /etc/n409/backup-verify.env).
#   ENV_OWNER   chown argument for that file (default root:n409). Empty skips.
#   DB_HOST / DB_PORT / DB_NAME
#               What the URL points at (default localhost / 5432 / postgres).
#               `postgres` is the maintenance database: the rehearsal connects
#               there to issue CREATE DATABASE for its scratch copy, and must
#               not connect to the application database to do it.
#   PSQL        How to reach postgres as a superuser
#               (default `sudo -u postgres psql`). Tests stub this.
#   PSQL_CLIENT Plain client used to connect as the provisioned role, to prove
#               the credential works (default `psql`). Tests stub this.
#   OPENSSL     Where the password comes from. Tests stub this.
set -euo pipefail

ROLE="${ROLE:-n409_verify}"
ENV_FILE="${ENV_FILE:-/etc/n409/backup-verify.env}"
ENV_OWNER="${ENV_OWNER-root:n409}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-postgres}"
PSQL="${PSQL:-sudo -u postgres psql}"
# The unprivileged client, used to connect *as* the provisioned role. Separate
# from PSQL because that one is the superuser path and this one must not be.
PSQL_CLIENT="${PSQL_CLIENT:-psql}"
OPENSSL="${OPENSSL:-openssl}"

log() { printf 'n409-verify-role: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Identifiers are interpolated into SQL below, so they are held to the shape an
# unquoted postgres identifier has. This is not defence against an attacker —
# anyone who can set ROLE can already run this script as root — it is defence
# against a typo or a stray quote turning a CREATE ROLE into something else
# entirely while running as the database superuser.
[[ "$ROLE" =~ ^[a-z_][a-z0-9_]*$ ]] || die "ROLE must be a plain lowercase identifier, got '$ROLE'"

psql_q() { $PSQL -qtAc "$1"; }

# ── Is this host already correct? ────────────────────────────────────────────
#
# Asked of the credential itself rather than of the catalogue, because what
# matters is not "does a role by this name exist" but "can the unit that reads
# this file do the thing it is going to be asked to do on Sunday". A role whose
# password no longer matches the file passes the first question and fails the
# second, silently, until the rehearsal fails.
existing_url=""
if [[ -f "$ENV_FILE" ]]; then
  existing_url="$(sed -n 's/^[[:space:]]*DATABASE_URL=//p' "$ENV_FILE" | tail -n 1)"
fi

if [[ -n "$existing_url" ]]; then
  # `SELECT rolcreatedb` rather than a bare connection check: LOGIN alone gets a
  # successful connect and then fails at the CREATE DATABASE, which is precisely
  # the failure R87 spent a Sunday morning on.
  if creatable="$(PGCONNECT_TIMEOUT=5 $PSQL_CLIENT "$existing_url" -qtAc \
    "SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user" 2>/dev/null)"; then
    if [[ "$(printf '%s' "$creatable" | tr -d '[:space:]')" == "t" ]]; then
      log "$ENV_FILE already names a working credential with CREATEDB — nothing to do"
      exit 0
    fi
    log "the credential in $ENV_FILE connects but cannot CREATE DATABASE — re-provisioning"
  else
    log "the credential in $ENV_FILE could not connect — re-provisioning"
  fi
else
  log "$ENV_FILE does not name a DATABASE_URL — provisioning"
fi

# ── Generate ─────────────────────────────────────────────────────────────────
#
# Hex, not base64. This value goes into a URL as the password component, and
# base64's `+` and `/` would have to be percent-encoded there — a step that is
# easy to write correctly here and easy to forget in the next place someone
# copies the URL to. Hex has no such characters and needs no encoding anywhere.
PASSWORD="$($OPENSSL rand -hex 32)"
[[ -n "$PASSWORD" ]] || die "could not generate a password"

# ── Create or update the role ────────────────────────────────────────────────
#
# The password is passed through psql's own variable interpolation rather than
# pasted into the statement, so it is quoted as a literal by psql instead of by
# this script guessing at postgres's escaping rules.
if [[ "$(psql_q "SELECT 1 FROM pg_roles WHERE rolname = '$ROLE'" | tr -d '[:space:]')" == "1" ]]; then
  log "$ROLE exists — resetting its password and confirming its privileges"
  $PSQL -qtA -v role="$ROLE" -v pw="$PASSWORD" \
    -c "ALTER ROLE :\"role\" WITH LOGIN CREATEDB PASSWORD :'pw'" >/dev/null
else
  log "creating $ROLE"
  $PSQL -qtA -v role="$ROLE" -v pw="$PASSWORD" \
    -c "CREATE ROLE :\"role\" WITH LOGIN CREATEDB PASSWORD :'pw'" >/dev/null
fi

# Stated rather than assumed. The whole argument for a separate role is that it
# holds CREATEDB *and nothing else*, so the absence of the rest is part of what
# is being provisioned — a role that picked up SUPERUSER from an earlier
# experiment would otherwise pass every check this script makes.
$PSQL -qtA -v role="$ROLE" \
  -c "ALTER ROLE :\"role\" WITH NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT" >/dev/null

# ── Write the env file ───────────────────────────────────────────────────────
ENV_DIR="$(dirname "$ENV_FILE")"
if [[ ! -d "$ENV_DIR" ]]; then
  install -d -m 0750 "$ENV_DIR"
  [[ -z "$ENV_OWNER" ]] || chown "$ENV_OWNER" "$ENV_DIR"
fi

# Written to a temp file in the same directory and moved into place: the unit
# may read this file at any moment, and a truncate-then-write leaves a window in
# which it reads a file with no DATABASE_URL in it and falls through to the
# application's. Created with the mode already correct rather than chmod'd
# afterwards, so the password is never on disk world-readable, even briefly.
TMP="$ENV_DIR/.$(basename "$ENV_FILE").tmp.$$"
trap 'rm -f "$TMP"' EXIT
install -m 0640 /dev/null "$TMP"
cat > "$TMP" <<EOF
# Written by infra/backup/provision-verify-role.sh. Do not edit by hand — the
# password here must match the one $ROLE was created with, and this file is the
# only record of it. To rotate, delete this file and re-run that script.
#
# Read by n409-backup-verify.service, listed *after* /opt/N409/.env so that this
# DATABASE_URL wins. See infra/backup/README.md.
DATABASE_URL=postgres://$ROLE:$PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME
EOF
[[ -z "$ENV_OWNER" ]] || chown "$ENV_OWNER" "$TMP"
mv -f "$TMP" "$ENV_FILE"
trap - EXIT

# ── Prove it, rather than reporting success ──────────────────────────────────
#
# The same question the top of the script asks, asked again of what was just
# written. Without this the script's success means "the statements did not
# error", which is not the same as "the unit will work on Sunday" — a role
# created against a postgres reachable only over a socket, with an env file
# naming localhost:5432, satisfies the first and fails the second.
verify_url="postgres://$ROLE:$PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
creatable="$(PGCONNECT_TIMEOUT=5 $PSQL_CLIENT "$verify_url" -qtAc \
  "SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user" 2>/dev/null || true)"
[[ "$(printf '%s' "$creatable" | tr -d '[:space:]')" == "t" ]] ||
  die "wrote $ENV_FILE but the credential in it cannot connect and CREATE DATABASE — the weekly verification would fail"

# Never the password. This runs under sudo, and its output lands in a terminal
# scrollback and, wired into provisioning, in a CI log.
log "$ROLE provisioned; $ENV_FILE written (mode 0640${ENV_OWNER:+, owner $ENV_OWNER})"
