#!/usr/bin/env bash
# Install this checkout's systemd units into /etc/systemd/system.
#
# WHY THIS EXISTS: deploy.sh has always shipped the unit files — `git archive`
# carries `infra/systemd/` and `infra/backup/` onto the host like every other
# tracked file — and then restarted the services *systemd* knew about, which are
# the copies under /etc/systemd/system. Those two sets are unrelated. Editing a
# unit in this repo therefore changed nothing on the box, forever, unless a human
# remembered to scp it across by hand.
#
# Nobody remembered. The units on 204.168.241.124 were dated 21 Jul while the
# repo's engine-wrapper unit had moved on 14 Aug, and the line that had not made
# the trip was:
#
#     Environment=APP_ENV=production
#
# which is the switch that turns engine-wrapper's INTERNAL_SERVICE_TOKEN guard
# from advisory into mandatory. Without it `enforce_token_configured` logs a
# warning instead of refusing to boot, and `internal_token_middleware` *passes
# unauthenticated requests through* whenever the secret is unset — the exact
# fail-open the guard was written to prevent, live in production, invisible from
# the repo. The secret happened to be set, so nothing was breached; the safety
# net was simply not there.
#
# The failure is worse than one missing line, because it is silent in both
# directions. preflight (deploy.sh section 4b) validates `$REMOTE_DIR/infra/
# systemd` — the copy `git archive` just unpacked — so it read the *correct*
# unit, found APP_ENV=production, and reported the estate healthy while the file
# systemd actually boots said otherwise. A checker pointed at a file nothing
# reads cannot fail.
#
# So: the repo becomes the authority. Every deploy copies the units into place,
# reloads systemd when any of them changed, and says which ones moved.
#
# Configuration (all overridable — the tests rely on this):
#   UNIT_DEST    Where systemd reads units from (default /etc/systemd/system).
#   SOURCE_DIRS  Space-separated dirs holding the units, relative to the repo
#                root, or absolute (default "infra/systemd infra/backup").
#   SYSTEMCTL    systemctl command to use. Tests stub this.
set -euo pipefail

UNIT_DEST="${UNIT_DEST:-/etc/systemd/system}"
SOURCE_DIRS="${SOURCE_DIRS:-infra/systemd infra/backup}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"

# Resolved from the script's own location, not `pwd`: deploy.sh runs this over
# ssh after a `cd`, but a human running it from anywhere should get the same
# units rather than whichever ones happen to sit under their shell.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

log() { printf 'n409-units: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

[[ -d "$UNIT_DEST" ]] || die "$UNIT_DEST does not exist — this host does not look like a systemd box"

# Collected first, installed second. Building the whole list before touching
# anything means a typo'd SOURCE_DIRS fails before half the estate has been
# rewritten, rather than after.
sources=()
for dir in $SOURCE_DIRS; do
  # Absolute paths pass through. Relative ones resolve against the checkout, so
  # the default names units in *this* commit no matter where it is run from.
  case "$dir" in /*) abs="$dir" ;; *) abs="$REPO_ROOT/$dir" ;; esac
  [[ -d "$abs" ]] || die "$dir is not a directory in this checkout"
  # nullglob so an empty dir contributes nothing instead of contributing the
  # literal pattern, which would then be reported as a missing file.
  shopt -s nullglob
  for f in "$abs"/*.service "$abs"/*.timer; do sources+=("$f"); done
  shopt -u nullglob
done
[[ ${#sources[@]} -gt 0 ]] || die "no .service or .timer files found under: $SOURCE_DIRS"

changed=()
for src in "${sources[@]}"; do
  name="$(basename "$src")"
  dst="$UNIT_DEST/$name"
  # `cmp -s` rather than a timestamp: a unit hand-edited on the box and a unit
  # merely re-unpacked by `git archive` have equally meaningless mtimes, and
  # what matters is whether the bytes systemd will read differ from the bytes
  # this commit specifies. A missing destination compares as different, which
  # is how a brand-new unit gets installed.
  if cmp -s "$src" "$dst"; then continue; fi
  [[ -f "$dst" ]] && log "$name: differs from this checkout — replacing" || log "$name: not installed — installing"
  # A temp file plus `mv` rather than `cp` onto the live path: `cp` truncates
  # first, so a failure mid-write leaves a half-written unit that systemd will
  # refuse to parse. `mv` within the same filesystem is atomic — the unit is
  # either the old one or the new one, never a fragment.
  tmp="$dst.n409-deploy.$$"
  cp "$src" "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$dst"
  changed+=("$name")
done

if [[ ${#changed[@]} -eq 0 ]]; then
  log "all ${#sources[@]} unit(s) already match this checkout"
else
  log "${#changed[@]} unit(s) changed: ${changed[*]}"
  # Before any enable/restart below. systemd caches unit files, so a `restart`
  # issued without this runs the *old* unit and prints a warning nobody reads —
  # which would reproduce, one layer down, exactly the drift this script exists
  # to close.
  $SYSTEMCTL daemon-reload
fi

# Enable is unconditional and idempotent. It is not about the changed set: a
# unit can be present and current on disk while not being wanted by any target,
# which is a box that comes back from a reboot with nothing running. Every unit
# here has an [Install] section, so this is a symlink that either already exists
# or should.
for src in "${sources[@]}"; do
  $SYSTEMCTL enable "$(basename "$src")" >/dev/null 2>&1 || log "$(basename "$src"): enable failed (continuing)"
done

# Timers, and only timers, are restarted here.
#
# A timer's schedule lives in the unit file, so a changed .timer that is never
# restarted keeps firing on the old schedule — the edit looks applied and is
# not. Restarting one is free: it re-arms a clock.
#
# The .service units are deliberately left alone. The five application services
# are restarted by deploy.sh section 6, which owns the ordering that matters
# (valuation first, because it runs the migrations). The two backup services are
# Type=oneshot bodies triggered by their timers — restarting n409-backup.service
# here would not "apply a change", it would take a database backup, and
# restarting n409-backup-verify.service would start a restore rehearsal.
for name in ${changed[@]+"${changed[@]}"}; do
  case "$name" in
    *.timer) log "$name: re-arming"; $SYSTEMCTL restart "$name" ;;
  esac
done
