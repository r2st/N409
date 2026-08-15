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
#   VALUATION_HEALTH_URL
#                 Base URL for valuation's own check (default http://localhost:3001).
#                 Waited on between the two restart steps — see section 6.
#   AI_HEALTH_URL / ENGINE_HEALTH_URL / REPORT_HEALTH_URL
#                 Base URLs for the three remaining units (defaults
#                 http://localhost:3002 / :3003 / :3004). All five are verified;
#                 see section 7.
#   CURL          curl command to use. Tests stub this.
#   SLEEP         sleep command to use. Tests stub this to make the waits free.
#   VERIFY_TIMEOUT   Seconds to allow a restarted service to come up (default 120).
#   VERIFY_INTERVAL  Seconds between probes while waiting (default 3).
#   SKIP_VERIFY   Set to 1 to skip the post-deploy verification (not advised).
#   SKIP_PREFLIGHT
#                 Set to 1 to skip validating the host's .env against the
#                 start-up guards before restarting (see section 4b). Skipping
#                 it does not make a bad config work — it only moves the
#                 discovery from a failed deploy to a failed service.
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
SLEEP="${SLEEP:-sleep}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000}"
VALUATION_HEALTH_URL="${VALUATION_HEALTH_URL:-http://localhost:3001}"
AI_HEALTH_URL="${AI_HEALTH_URL:-http://localhost:3002}"
ENGINE_HEALTH_URL="${ENGINE_HEALTH_URL:-http://localhost:3003}"
REPORT_HEALTH_URL="${REPORT_HEALTH_URL:-http://localhost:3004}"
VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-120}"
VERIFY_INTERVAL="${VERIFY_INTERVAL:-3}"

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

# Single-quote a string for the *remote* shell.
#
# ssh has no argv to hand over: it concatenates its arguments and gives the
# result to a login shell on the far side. So a path is parsed twice — once
# here, once there — and quoting it locally does nothing for the second pass.
# `git ls-files` in this repo already lists four paths with spaces in them, two
# of those with parentheses as well, so this is the ordinary case rather than
# the exotic one.
#
# The escape is the standard '\'' idiom: close the quoted run, emit a literal
# quote, reopen. Everything else — spaces, parens, $, ;, globs — is inert
# inside single quotes, so nothing else needs special handling.
shq() { local s=${1//\'/\'\\\'\'}; printf "'%s'" "$s"; }

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

if [[ "${SKIP_VERIFY:-0}" == "1" ]]; then VERIFY=0; else VERIFY=1; fi

# The waits count *attempts* rather than watching a clock. That keeps the budget
# deterministic, and it is the only form the tests can drive: they stub `sleep`
# to a no-op, which no elapsed-time check would survive.
VERIFY_ATTEMPTS=$(( VERIFY_INTERVAL > 0 ? VERIFY_TIMEOUT / VERIFY_INTERVAL : 1 ))
(( VERIFY_ATTEMPTS > 0 )) || VERIFY_ATTEMPTS=1

# Set by wait_for_build when it gives up, so the caller can report what the host
# was actually saying rather than just that it was not the wanted SHA.
LAST_LIVE_SHA=""

# One probe. A failure here is not fatal and not news: the callers poll, and
# "nothing is listening yet" is the *expected* answer for the first few seconds
# after a restart. `|| true` keeps it out of `set -e`'s reach, and out of the
# `pipefail` reach of the sed that consumes it.
remote_curl() {
  $SSH ${KEY_ARGS[@]+"${KEY_ARGS[@]}"} "$HOST" "$CURL -sf $1" 2>/dev/null || true
}

# Wait for a restarted service to come back up on the commit we just deployed.
#
# THE RACE THIS CLOSES: all five units are Type=simple, so `systemctl restart`
# returns as soon as the new process has been *forked* — not when it has booted
# and is listening. A probe fired immediately afterwards therefore races the
# boot, and normally loses: curl gets connection-refused, `-sf` exits non-zero,
# and the deploy dies reporting `/health reports '<none>'`. That verdict is not
# merely wrong, it is misdirecting — the new code IS live, and the message sends
# the deployer hunting for a build or a restart that did not take, or into a
# rollback of a deploy that in fact succeeded. Polling to a deadline turns a
# timing accident back into the check this was meant to be: proof that the new
# build answers.
#
# The SHA is the right thing to poll for rather than mere reachability, because
# registerHealth() reads BUILD_SHA once at boot: an old process that has not yet
# died still reports the *old* commit, so a match cannot be satisfied by the
# release we are replacing.
wait_for_build() {
  local label="$1" base="$2" live="" i
  if [[ "$VERIFY" -eq 0 ]]; then return 0; fi
  if [[ "$APPLY" -eq 0 ]]; then
    printf '  [dry-run] wait for %s at %s/health to report %s\n' "$label" "$base" "${SHA:0:7}" >&2
    return 0
  fi
  for (( i = 1; i <= VERIFY_ATTEMPTS; i++ )); do
    live="$(remote_curl "$base/health" | sed -n 's/.*"build_sha":"\([^"]*\)".*/\1/p')"
    if [[ "$live" == "$SHA" ]]; then
      log "$label is up on ${SHA:0:7}"
      return 0
    fi
    $SLEEP "$VERIFY_INTERVAL"
  done
  LAST_LIVE_SHA="$live"
  return 1
}

# Wait for readiness, which legitimately lags liveness: /ready probes upstreams,
# so it can answer 503 for a while after the service itself is serving.
wait_for_ready() {
  local label="$1" base="$2" i
  if [[ "$VERIFY" -eq 0 ]]; then return 0; fi
  if [[ "$APPLY" -eq 0 ]]; then
    printf '  [dry-run] wait for %s at %s/ready\n' "$label" "$base" >&2
    return 0
  fi
  for (( i = 1; i <= VERIFY_ATTEMPTS; i++ )); do
    if $SSH ${KEY_ARGS[@]+"${KEY_ARGS[@]}"} "$HOST" "$CURL -sf $base/ready >/dev/null"; then
      return 0
    fi
    $SLEEP "$VERIFY_INTERVAL"
  done
  return 1
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
# An explicit template path rather than `mktemp -t`: BSD mktemp on macOS ignores
# TMPDIR under -t and always writes to the per-user Darwin temp directory, which
# left the script's scratch files somewhere no test could point at — the reason
# the "leaves nothing behind" assertion globbed /tmp and matched nothing for as
# long as it existed. A full template is honoured identically by BSD and GNU.
#
# mktemp also creates the file it names, so appending .tar.gz names a *different*
# one and the original has to be cleaned up too, or every deploy leaves an empty
# file behind. Hence the stem is kept in its own variable rather than recomputed:
# the trap has to name both paths, and the one mktemp actually created is not
# derivable from "$TARBALL" without stripping a suffix off it.
#
# DELETED_LIST joins the same trap, but section 3 may never run — a failed
# archive or a failed scp exits first — and the trap body is evaluated at exit,
# whenever that is. The :+ guard is what covers that: it expands to nothing for
# a variable that is empty *or* unset, and it is one of the forms `set -u`
# permits on an unset name, so the cleanup still runs on the abort path instead
# of dying on the variable it was about to clean up. The declaration below is
# documentation — it puts the name in view next to the other two temp files
# rather than leaving it to appear only inside a branch a hundred lines down.
TMP_ROOT="${TMPDIR:-/tmp}"
TARBALL_STEM="$(mktemp "${TMP_ROOT%/}/n409-deploy-XXXXXX")"
TARBALL="${TARBALL_STEM}.tar.gz"
DELETED_LIST=""
trap 'rm -f "$TARBALL_STEM" "$TARBALL" ${DELETED_LIST:+"$DELETED_LIST"}' EXIT
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
  # -z into a file, not newlines into a variable. `--name-only` alone C-quotes
  # any path that is not plain ASCII — `café.txt` comes back as the seven
  # literal characters `"caf\303\251.txt"`, quotes included — so the sweep would
  # ask the host to remove a filename that has never existed and `rm -f` would
  # agree, silently. -z emits raw bytes and never quotes; it needs a file
  # because bash cannot hold a NUL in a variable at all.
  DELETED_LIST="$(mktemp "${TMP_ROOT%/}/n409-deleted-XXXXXX")"
  $GIT diff --diff-filter=D --name-only -z "$PREV_SHA" HEAD >"$DELETED_LIST" || true
  DELETED_COUNT="$(tr -cd '\0' <"$DELETED_LIST" | wc -c | tr -d ' ')"
  if [[ "$DELETED_COUNT" -gt 0 ]]; then
    log "removing ${DELETED_COUNT} file(s) deleted since ${PREV_SHA:0:7}"
    while IFS= read -r -d '' f; do
      [[ -n "$f" ]] || continue
      # Quoted, because the remote shell re-parses this. Unquoted, a path with
      # a space became several arguments and `rm -f` removed none of them while
      # exiting 0 — the sweep reporting success over a file still live, which is
      # the very failure it exists to prevent. A path with parentheses was worse:
      # a syntax error on the far side, fatal under `set -e`, aborting the deploy
      # after the tree was unpacked but before it was built.
      run_remote "rm -f $(shq "$REMOTE_DIR/$f")"
    done <"$DELETED_LIST"
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

# ── 4b. Validate the host's config before anything is restarted ──────────────
#
# The guards this runs are the ones the services run at boot: loadConfig's zod
# schema and its production-only checks, plus the INTERNAL_SERVICE_TOKEN
# requirement the report service and the two Python services enforce. Nothing
# here is new except the moment.
#
# That moment is the point. Every one of those guards used to be evaluated for
# the first time *inside* a booting process, which gives a bad config only two
# ways to surface: as a crash-looping unit with the old process already stopped,
# or — if the guard did not exist yet when the config was written — not at all.
# The second is what happened to Stripe: STRIPE_SECRET_KEY set with no
# STRIPE_WEBHOOK_SECRET, checkout charging cards that nothing could fulfil,
# live for 324 commits and found by an outage rather than by this repo.
#
# Run here, a fault costs a failed deploy with the previous release still
# serving. Fatal, like the build above, and for the same reason.
#
# --env-file is passed explicitly rather than trusting the unit's own path: it
# makes the file being validated the file named in this script, so a host whose
# .env has been moved fails loudly instead of validating one that nothing reads.
if [[ "${SKIP_PREFLIGHT:-0}" == "1" ]]; then
  log "SKIP_PREFLIGHT=1 — not validating the host's configuration"
else
  log "validating $REMOTE_DIR/.env against the start-up guards"
  run_remote "cd $REMOTE_DIR/src/services/valuation && node dist/preflight-cli.js --env-file $REMOTE_DIR/.env --unit-dir $REMOTE_DIR/infra/systemd" \
    || die "the host's configuration would be rejected at boot — nothing was restarted, the previous release is still serving. Fix $REMOTE_DIR/.env and deploy again (SKIP_PREFLIGHT=1 overrides, which trades a failed deploy for a failed service)"
fi

# ── 5. Record what was built — after the build, never before ─────────────────
# The SHA is the local one. See the header: the server's HEAD does not move.
run_remote "printf '%s\n' $SHA > $REMOTE_DIR/BUILD_SHA && chown $SERVICE_USER:$SERVICE_USER $REMOTE_DIR/BUILD_SHA"

# ── 6. Restart — valuation first, it runs the migrations ─────────────────────
#
# "First" has to mean *finished*, not merely *issued*. Type=simple makes
# `systemctl restart` return at fork, so without the wait below this step only
# ordered the two ssh calls: the dependent services booted and began probing
# valuation while its migrations were still running. They survived that —
# Restart=always, and /ready answering 503 for a while — but the ordering this
# step exists to guarantee was never actually enforced. valuation awaits
# migrate() before listen(), so /health answering at all is precisely the
# "migrations are done" signal.
run_remote "systemctl restart n409-valuation"
wait_for_build "valuation" "$VALUATION_HEALTH_URL" \
  || die "valuation did not come up on $SHA within ${VERIFY_TIMEOUT}s (last /health said '${LAST_LIVE_SHA:-<none>}') — the other services were deliberately NOT restarted, so the previous release is still serving them"
run_remote "systemctl restart n409-web n409-ai n409-engine-wrapper n409-report"

# ── 7. Verify, or the deploy is only a hope ──────────────────────────────────
if [[ "$VERIFY" -eq 0 ]]; then
  log "SKIP_VERIFY=1 — not verifying"
  exit 0
fi
if [[ "$APPLY" -eq 0 ]]; then
  log "dry run complete — nothing was changed"
  exit 0
fi

log "verifying (up to ${VERIFY_TIMEOUT}s)"
wait_for_build "web" "$HEALTH_URL" \
  || die "deployed $SHA but /health reports '${LAST_LIVE_SHA:-<none>}' — the build or the restart did not take"

# The other three units were restarted in step 6 and, until now, never checked.
# `systemctl restart` returns at fork under Type=simple, so "restarted" was only
# ever "asked to restart": a unit that failed to start, or one whose venv did not
# update, left the *previous* process serving and the deploy reported success.
# Every service reports the commit it booted on now — the two FastAPI ones
# gained the field for this — so all five answer the same question the same way.
for probe in "ai:$AI_HEALTH_URL" "engine:$ENGINE_HEALTH_URL" "report:$REPORT_HEALTH_URL"; do
  wait_for_build "${probe%%:*}" "${probe#*:}" \
    || die "deployed $SHA but ${probe%%:*} reports '${LAST_LIVE_SHA:-<none>}' — that unit did not pick up the release"
done

wait_for_ready "web" "$HEALTH_URL" \
  || die "/ready is not passing after the restart"

log "deployed $SHA and verified live"
