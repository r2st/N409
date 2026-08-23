#!/usr/bin/env bash
# Install this checkout's journald drop-in and prove journald is reading it.
#
# WHY THIS EXISTS: R88 gave the repo authority over the systemd units and R89
# gave it a check over the Caddyfile. The journal was the remaining piece of
# host configuration that lived nowhere. Every N409 service logs to stdout and
# systemd puts that in the journal; how big that journal may get, how long it is
# kept, and whether it survives a reboot were all whatever the distro happened
# to default to, unrecorded and unreviewed. On a single-disk host an unbounded
# journal is an outage whose first symptom is Postgres refusing writes.
#
# WHY IT INSTALLS RATHER THAN CHECKS. The Caddyfile could not be installed
# because ours is one site block inside a file that serves two other products.
# `journald.conf.d/` has no such problem: it is a drop-in directory, our file is
# ours alone, and the values in it bound the journal for everything on the box —
# which is the outcome wanted for the other two products as well.
#
# WHY IT VERIFIES AFTERWARDS. R88's real lesson was not "copy the file", it was
# "a checker pointed at a file nothing reads cannot fail". Writing into
# journald.conf.d/ and reporting success proves only that a write succeeded: the
# directory may not be one this journald consults, the daemon may have refused
# to reload, or a later-sorting drop-in may override every line. So the last
# thing this does is ask systemd what journald's *effective* configuration is
# and confirm our values are in it.
#
# Configuration (all overridable — the tests rely on this):
#   JOURNALD_DEST  Drop-in directory (default /etc/systemd/journald.conf.d).
#   JOURNALD_SRC   The file to install, relative to the repo root or absolute
#                  (default infra/journald/10-n409.conf).
#   SYSTEMCTL      systemctl command to use. Tests stub this.
#   SYSTEMD_ANALYZE  systemd-analyze command to use. Tests stub this.
set -euo pipefail

JOURNALD_DEST="${JOURNALD_DEST:-/etc/systemd/journald.conf.d}"
JOURNALD_SRC="${JOURNALD_SRC:-infra/journald/10-n409.conf}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
SYSTEMD_ANALYZE="${SYSTEMD_ANALYZE:-systemd-analyze}"

# Resolved from the script's own location, not `pwd` — same reasoning as
# install-units.sh: deploy.sh runs this over ssh after a `cd`, and a human
# running it from anywhere should get this commit's file.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

log() { printf 'n409-journald: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

case "$JOURNALD_SRC" in /*) src="$JOURNALD_SRC" ;; *) src="$REPO_ROOT/$JOURNALD_SRC" ;; esac
[[ -f "$src" ]] || die "$JOURNALD_SRC is not a file in this checkout"

name="$(basename "$src")"
dst="$JOURNALD_DEST/$name"

# The directory is part of the interface, not a precondition: a host that has
# never had a drop-in does not have it, and refusing there would mean this only
# ever works on a box somebody had already prepared by hand — which is the
# failure mode being closed, not a state to demand.
[[ -d "$JOURNALD_DEST" ]] || { log "$JOURNALD_DEST: creating"; mkdir -p "$JOURNALD_DEST"; }

changed=0
# `cmp -s` rather than mtimes, for the same reason install-units.sh uses it:
# what matters is whether the bytes journald will read differ from the bytes
# this commit specifies. A missing destination compares as different.
if cmp -s "$src" "$dst"; then
  log "$name: already matches this checkout"
else
  [[ -f "$dst" ]] && log "$name: differs from this checkout — replacing" || log "$name: not installed — installing"
  # Temp file plus `mv`: `cp` truncates first, and a failure mid-write would
  # leave a half-written stanza that journald parses as far as it got.
  tmp="$dst.n409-deploy.$$"
  cp "$src" "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$dst"
  changed=1
fi

if [[ "$changed" == "1" ]]; then
  # journald reads its configuration once, at start. `systemctl restart` rather
  # than a reload because journald has no reload verb that re-reads limits; the
  # restart is sub-second and the socket buffers across it, so nothing logged
  # during it is lost.
  log "restarting systemd-journald so the new limits take effect"
  $SYSTEMCTL restart systemd-journald || die "systemd-journald would not restart — the drop-in is in place but not in effect"
fi

# ── Verification: is journald actually reading it? ───────────────────────────
#
# `systemd-analyze cat-config` prints the merged configuration, drop-ins
# included and in the order they are applied, which is the only thing here that
# can distinguish "the file exists" from "the file is the answer". A value of
# ours that does not survive the merge means something sorts after us and
# overrides it — invisible from the file itself.
effective="$($SYSTEMD_ANALYZE cat-config systemd/journald.conf 2>/dev/null || true)"
if [[ -z "$effective" ]]; then
  die "could not read journald's effective configuration — cannot confirm $name is in force"
fi

missing=()
# Only the settings whose absence is a silent production problem. Compress and
# the rate limit are checked too because a drop-in that lost *any* line lost it
# for the same reason, and a partial application is the case worth catching.
for setting in Storage SystemMaxUse MaxRetentionSec RateLimitBurst; do
  # `|| true` on every one of these: with `pipefail` a grep that matches
  # nothing fails the pipeline, and `set -e` would then turn "this setting is
  # missing from the merged config" — the single most important thing this loop
  # can find — into the script dying without saying anything at all.
  want="$(grep -E "^${setting}=" "$src" | tail -n 1 || true)"
  [[ -n "$want" ]] || continue
  # cat-config indents nothing and preserves the assignment verbatim, so an
  # exact-line match is the right comparison: `SystemMaxUse=512M` present but
  # overridden later shows up as the later line winning, and grep -F -x on the
  # *last* occurrence is what tells the two apart.
  last="$(grep -E "^${setting}=" <<<"$effective" | tail -n 1 || true)"
  [[ "$last" == "$want" ]] || missing+=("$setting (wanted '$want', effective '${last:-<unset>}')")
done

if [[ ${#missing[@]} -gt 0 ]]; then
  log "journald's effective configuration does not match this checkout:"
  # `${arr[@]+...}` guard: an empty array under `set -u` is an unbound
  # variable on bash 3.2, which would turn a diagnostic into a silent death.
  for m in ${missing[@]+"${missing[@]}"}; do log "  - $m"; done
  die "$name is on disk but not in force — check for a later-sorting drop-in in $JOURNALD_DEST"
fi

log "journald limits in force: $(grep -E '^SystemMaxUse=' <<<"$effective" | tail -n 1 || true), $(grep -E '^MaxRetentionSec=' <<<"$effective" | tail -n 1 || true)"
