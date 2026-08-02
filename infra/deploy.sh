#!/usr/bin/env bash
# N409 deploy — the procedure in infra/DEPLOYMENT.md, run instead of read.
#
# That document describes seven manual steps and spends most of its length on
# the four ways they go wrong. Every one of those is a step a human skips or
# gets subtly wrong under time pressure, and each fails *quietly*:
#
#   - Skipping the build. `dist/` is gitignored, so the archive carries no
#     compiled output. A deploy that unpacks and restarts without building is a
#     no-op that leaves the previous release running while reporting success.
#   - Taking the SHA from the server. `git archive` updates the working tree
#     without moving the server's HEAD, so `git -C /opt/N409 rev-parse HEAD`
#     names whatever was last checked out there. That writes a confidently wrong
#     BUILD_SHA — worse than the "unknown" the file exists to replace.
#   - Forgetting deletions. `git archive` never removes anything, so a file
#     deleted in a commit stays live on the host indefinitely.
#   - Restarting in the wrong order. Migrations run on n409-valuation's boot.
#
# It also encodes two rules the document states but cannot enforce: BUILD_SHA is
# written only after a build that actually succeeded, and nothing is restarted
# if the build failed — a half-built tree must keep serving the old release
# rather than restart into a broken one.
#
# Configuration (all overridable — the tests rely on this):
#   HOST          Deploy target, e.g. root@204.168.241.124. Required to --apply.
#   REMOTE_DIR    Code directory on the host (default /opt/N409).
#   SSH_KEY       Identity file passed to ssh/scp (default keys/hetzner_ustradingbot).
#                 Set it to "" to use ssh-agent. Naming a file that cannot be
#                 read is fatal — see the KEY_ARGS block for why.
#   SERVICE_USER  Owner of the deployed tree (default n409).
#   SSH / SCP     Commands to use. Tests stub these.
#   GIT           git command to use (default "git").
#   HEALTH_URL    Base URL for the post-deploy check (default http://localhost:3000).
#   CURL          curl command to use. Tests stub this.
#   SKIP_VERIFY   Set to 1 to skip the post-deploy verification (not advised).
#
# Usage:
#   infra/deploy.sh                    # dry run — prints the plan, touches nothing
#   infra/deploy.sh --apply            # deploy HEAD
#   infra/deploy.sh --apply --allow-dirty
#
# Dry run is the default on purpose: this is the one script in the repo whose
# accidental invocation restarts production.
set -euo pipefail

REMOTE_DIR="${REMOTE_DIR:-/opt/N409}"
SERVICE_USER="${SERVICE_USER:-n409}"
# Recorded before the default is applied: an SSH_KEY the caller *named* is held
# to a stricter standard than the default one. `${SSH_KEY+1}` is the set-or-not
# test, not the non-empty test — SSH_KEY="" is a deliberate "use ssh-agent".
SSH_KEY_EXPLICIT="${SSH_KEY+1}"
# `-`, not `:-`: the default applies only when SSH_KEY is *unset*. With `:-` an
# explicit SSH_KEY="" would be overwritten by the default path, turning "use
# ssh-agent" into "use a key that isn't there".
SSH_KEY="${SSH_KEY-keys/hetzner_ustradingbot}"
SSH="${SSH:-ssh}"
SCP="${SCP:-scp}"
GIT="${GIT:-git}"
CURL="${CURL:-curl}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000}"

APPLY=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    # The header block, however long it grows — a hardcoded line range silently
    # truncates the help the moment anything above is edited.
    -h|--help) sed -n '2,/^[^#]/p' "$0" | sed '$d'; exit 0 ;;
    *) printf 'n409-deploy: unknown argument %s\n' "$arg" >&2; exit 2 ;;
  esac
done

log() { printf 'n409-deploy: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# `run` is the single choke point between planning and doing. In a dry run it
# prints the remote command and returns; there is no other path to the host, so
# a dry run cannot touch production even if a later step forgets to check.
run_remote() {
  if [[ "$APPLY" -eq 0 ]]; then
    # Plain %s, not %q: the plan is meant to be read, and shell-quoting turns
    # `systemctl restart n409-valuation` into backslash soup.
    printf '  [dry-run] ssh %s -- %s\n' "$HOST_DISPLAY" "$*" >&2
    return 0
  fi
  $SSH ${KEY_ARGS[@]+"${KEY_ARGS[@]}"} "$HOST" "$*"
}

# ── 1. What are we deploying? ────────────────────────────────────────────────
SHA="$($GIT rev-parse HEAD)"
[[ -n "$SHA" ]] || die "could not resolve HEAD in the local checkout"

# A dirty tree is refused rather than warned about. The archive is built from
# HEAD, so uncommitted work is silently *not* deployed while BUILD_SHA claims
# the commit — the deployer's mental model and the host disagree, and /health
# reports the wrong answer with full confidence.
if [[ "$ALLOW_DIRTY" -eq 0 ]]; then
  if [[ -n "$($GIT status --porcelain)" ]]; then
    die "working tree is dirty — commit, stash, or pass --allow-dirty (the archive is built from HEAD, so uncommitted changes would NOT be deployed while BUILD_SHA claims this commit)"
  fi
fi

HOST_DISPLAY="${HOST:-<HOST unset>}"
if [[ "$APPLY" -eq 1 ]]; then
  [[ -n "${HOST:-}" ]] || die "HOST is required to --apply (e.g. HOST=root@204.168.241.124)"
fi

# An array, not a string: an identity path with a space in it must stay one
# argument, and an *absent* key must expand to nothing rather than to "".
#
# Expanded below as ${KEY_ARGS[@]+"${KEY_ARGS[@]}"} rather than plain
# "${KEY_ARGS[@]}". macOS still ships bash 3.2, where expanding an *empty*
# array under `set -u` aborts with "unbound variable" — and the documented
# workflow is to run this from the local (often macOS) checkout, so the
# no-key path would have died on the deployer's own machine.
KEY_ARGS=()
if [[ -n "$SSH_KEY" ]]; then
  if [[ -r "$SSH_KEY" ]]; then
    KEY_ARGS=(-i "$SSH_KEY")
  elif [[ -n "$SSH_KEY_EXPLICIT" ]]; then
    # The *default* key is allowed to be missing: not every checkout holds it,
    # and ssh-agent is a legitimate way in. But a deployer who names an identity
    # file and gets silently downgraded to whatever the agent happens to offer
    # is authenticating as someone they did not choose — and would read the
    # resulting "Permission denied" as the host being broken. Same family as the
    # other four traps: it fails quietly, in a way that misdirects the fix.
    die "SSH_KEY names '$SSH_KEY', which is not readable — fix the path, or set SSH_KEY= (empty) to use ssh-agent deliberately"
  fi
fi

log "deploying ${SHA} to ${HOST_DISPLAY}:${REMOTE_DIR}$([[ "$APPLY" -eq 0 ]] && echo ' (DRY RUN)')"

# ── 2. Ship the tree ─────────────────────────────────────────────────────────
# git archive carries only tracked files at HEAD, so .env, keys/, node_modules/,
# dist/ and the .venvs on the host are left alone.
TARBALL="$(mktemp -t n409-deploy-XXXXXX).tar.gz"
trap 'rm -f "$TARBALL"' EXIT
$GIT archive --format=tar.gz -o "$TARBALL" HEAD
log "archive: $(wc -c <"$TARBALL" | tr -d ' ') bytes"

if [[ "$APPLY" -eq 1 ]]; then
  $SCP ${KEY_ARGS[@]+"${KEY_ARGS[@]}"} "$TARBALL" "$HOST:/tmp/n409-deploy.tar.gz"
else
  printf '  [dry-run] scp %s %s:/tmp/n409-deploy.tar.gz\n' "$TARBALL" "$HOST_DISPLAY" >&2
fi
run_remote "cd $REMOTE_DIR && tar -xzf /tmp/n409-deploy.tar.gz && rm -f /tmp/n409-deploy.tar.gz"

# ── 3. Remove what the commit removed ────────────────────────────────────────
# tar never deletes. Files dropped since the deployed commit would otherwise
# stay live forever — including routes and migrations that were deliberately
# withdrawn. The previously deployed SHA comes from the host's BUILD_SHA, which
# is the only trustworthy record of what is actually running there.
PREV_SHA="$(run_remote "cat $REMOTE_DIR/BUILD_SHA 2>/dev/null || true" | tr -d '[:space:]' || true)"
if [[ -n "$PREV_SHA" && "$PREV_SHA" != "unknown" ]] && $GIT cat-file -e "${PREV_SHA}^{commit}" 2>/dev/null; then
  DELETED="$($GIT diff --diff-filter=D --name-only "$PREV_SHA" HEAD || true)"
  if [[ -n "$DELETED" ]]; then
    log "removing $(printf '%s\n' "$DELETED" | wc -l | tr -d ' ') file(s) deleted since ${PREV_SHA:0:7}"
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      run_remote "rm -f $REMOTE_DIR/$f"
    done <<<"$DELETED"
  fi
else
  log "no usable BUILD_SHA on the host — skipping deletion sweep (files removed since the last deploy may linger)"
fi

# ── 4. Build. Mandatory, and fatal. ──────────────────────────────────────────
# Nothing below this line runs if the build fails: the old release keeps serving
# rather than restarting into a tree that does not compile.
log "building on the host (npm ci && npm run build)"
run_remote "cd $REMOTE_DIR && npm ci && npm run build" \
  || die "build failed on the host — nothing was restarted, the previous release is still serving"

# Python deps only when a requirements file actually moved, so the usual deploy
# does not pay for a pip resolve.
if [[ -n "$PREV_SHA" ]] && $GIT cat-file -e "${PREV_SHA}^{commit}" 2>/dev/null; then
  for svc in ai engine-wrapper; do
    if $GIT diff --name-only "$PREV_SHA" HEAD -- "src/services/$svc/requirements.txt" | grep -q .; then
      log "$svc: requirements.txt changed — installing"
      run_remote "cd $REMOTE_DIR/src/services/$svc && .venv/bin/pip install -r requirements.txt" \
        || die "$svc pip install failed — nothing was restarted"
    fi
  done
fi

# ── 5. Record what was built — after the build, never before ─────────────────
# The SHA is the local one. See the header: the server's HEAD does not move.
run_remote "printf '%s\n' $SHA > $REMOTE_DIR/BUILD_SHA && chown $SERVICE_USER:$SERVICE_USER $REMOTE_DIR/BUILD_SHA"

# ── 6. Restart — valuation first, it runs the migrations ─────────────────────
run_remote "systemctl restart n409-valuation"
run_remote "systemctl restart n409-web n409-ai n409-engine-wrapper n409-report"

# ── 7. Verify, or the deploy is only a hope ──────────────────────────────────
if [[ "${SKIP_VERIFY:-0}" == "1" ]]; then
  log "SKIP_VERIFY=1 — not verifying"
  exit 0
fi
if [[ "$APPLY" -eq 0 ]]; then
  log "dry run complete — nothing was changed"
  exit 0
fi

log "verifying"
LIVE_SHA="$($SSH ${KEY_ARGS[@]+"${KEY_ARGS[@]}"} "$HOST" "$CURL -sf $HEALTH_URL/health" | sed -n 's/.*"build_sha":"\([^"]*\)".*/\1/p')"
[[ "$LIVE_SHA" == "$SHA" ]] \
  || die "deployed $SHA but /health reports '${LIVE_SHA:-<none>}' — the build or the restart did not take"

$SSH ${KEY_ARGS[@]+"${KEY_ARGS[@]}"} "$HOST" "$CURL -sf $HEALTH_URL/ready >/dev/null" \
  || die "/ready is not passing after the restart"

log "deployed $SHA and verified live"
