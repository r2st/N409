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
#   SKIP_CADDY_CHECK
#                 Set to 1 to skip comparing /etc/caddy/Caddyfile with this
#                 checkout's site block before restarting (see section 4d).
#                 The edge config is the one thing a deploy cannot install, so
#                 this is the one check that can only report.
#   SKIP_JOURNALD Set to 1 to skip installing the journald drop-in and
#                 confirming its limits are in force (see section 4c2).
#                 Skipping it leaves the journal bounded by whatever the distro
#                 defaults to, which is where it was before this step existed.
#
# Usage:
#   infra/deploy.sh                    # dry run — prints the plan, touches nothing
#   infra/deploy.sh --apply            # deploy HEAD
#   infra/deploy.sh --apply --allow-dirty
#   infra/deploy.sh --apply --to=<sha> # deploy a commit you name
#   infra/deploy.sh --apply --rollback # deploy the previous verified release
#
# Rolling back is a deploy of an earlier commit through this same path — same
# archive, same preflight, same restart order, same verification. There is no
# separate restore mechanism, because a code path only ever exercised when
# production is already broken is one nobody has confidence in.
#
# --rollback takes its target from $REMOTE_DIR/RELEASES, which section 8 appends
# to after a deploy verifies. The commit has to exist in *this* clone: the
# archive ships from here, not from the host. It does NOT roll back the schema —
# migrations are forward-only and additive, so the older code runs against the
# newer schema by design (see src/services/valuation/src/db/migrationSafety.ts,
# which is what keeps "additive" true).
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
ROLLBACK=0
# The commit to ship. HEAD unless --to names one, or --rollback resolves one
# from the host's release log.
DEPLOY_REF="HEAD"
EXPLICIT_REF=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --rollback) ROLLBACK=1 ;;
    --to=*) DEPLOY_REF="${arg#*=}"; EXPLICIT_REF=1 ;;
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
#
# `curl -sf` treats the 200 that a `degraded` body carries as a pass, which is
# the intended reading (round 361): since then only the units a service cannot
# serve without gate the status code, and the AI and engine units — which
# `index.ts` refuses to require at boot for exactly this reason — are reported
# rather than gating. A lapsed OPENROUTER_API_KEY used to end this deploy on
# "/ready is not passing after the restart" with every page of the product
# serving fine. The degraded state is still visible: `status` says the word and
# `checks` names the unit, and `n409-ai` / `n409-engine` are scrape targets of
# their own now, so `up` is what alerts on it.
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

# ── 1b. Which commit? ────────────────────────────────────────────────────────
#
# Normally HEAD, which is what every deploy before rollback existed did. Two
# things can now name a different one.
#
# WHAT ROLLING BACK IS HERE. There is no separate rollback mechanism and
# deliberately so: rolling back is a deploy of an earlier commit, through the
# identical path — same archive, same preflight, same restart order, same
# verification. A bespoke "restore" path would be the one code path in this
# script that is only ever exercised when production is already broken, and
# therefore the one nobody has confidence in. This way the rollback path is the
# path that runs every day.
#
# WHAT IT DOES NOT DO: it does not touch the schema. The migration runner is
# forward-only (src/services/valuation/src/db/migrate.ts) — there are no
# down-steps to run and nothing here would run them. That is safe only because
# every migration is additive, so the newer schema is a superset of what the
# older code expects; `migrationSafety.ts` is what keeps that true, and the
# warning below is printed because the operator reaching for this at 3am should
# not have to have read either file.
if [[ "$ROLLBACK" -eq 1 ]]; then
  if [[ "$EXPLICIT_REF" -eq 1 ]]; then
    die "--rollback and --to= are two ways of naming the same thing; pass one. --to=<sha> deploys a commit you name, --rollback picks the previous entry from $REMOTE_DIR/RELEASES."
  fi
  if [[ "$APPLY" -eq 0 ]]; then
    # A dry run does not contact the host — that promise is the reason a dry run
    # is the default — so the previous release simply cannot be looked up here.
    # Refusing is the honest answer; picking HEAD and calling it a rollback
    # would be the dangerous one.
    die "--rollback resolves its target from $REMOTE_DIR/RELEASES on the host, and a dry run does not contact the host. Pass --to=<sha> to see the full plan for a commit you name, or --apply to roll back for real."
  fi
  CURRENT_SHA="$(run_remote "cat $REMOTE_DIR/BUILD_SHA 2>/dev/null || true" | tr -d '"'"'[:space:]'"'"' || true)"
  RELEASE_LOG="$(run_remote "cat $REMOTE_DIR/RELEASES 2>/dev/null || true" \
    | awk '{print $NF}' | grep -E '^[0-9a-f]{7,40}$' || true)"

  # The target is the entry immediately *before* the running commit's last
  # appearance — not merely "the newest entry that isn't the running one".
  #
  # The difference only shows up on the second consecutive rollback, which is
  # exactly when it matters most. Rolling back does not append (see section 8),
  # so with a log of A,B,C and C running, one rollback lands on B; the log still
  # reads A,B,C and B is now running, so the next rollback finds B's position and
  # lands on A. Under "newest entry that isn't running" the second rollback would
  # find C and roll *forward* into the release the operator had just undone —
  # under a flag that says the opposite, at the moment they are least able to
  # check.
  #
  # Walking to the last occurrence also absorbs a re-deploy of the same commit,
  # which appends a second identical entry.
  ROLLBACK_SHA="$(printf '%s\n' "$RELEASE_LOG" \
    | awk -v cur="${CURRENT_SHA:-__none__}" '
        $0 == cur { if (prev != "") target = prev; next }
        { prev = $0 }
        END { if (target != "") print target }' || true)"

  # The running commit is not in the log at all — it was deployed with
  # SKIP_VERIFY, or predates the log. There is no position to walk back from, so
  # fall back to the newest release that is not the one running.
  if [[ -z "$ROLLBACK_SHA" ]]; then
    ROLLBACK_SHA="$(printf '%s\n' "$RELEASE_LOG" | grep -vx "${CURRENT_SHA:-__none__}" | tail -n 1 || true)"
  fi
  [[ -n "$ROLLBACK_SHA" ]] || die "no previous release to roll back to — $REMOTE_DIR/RELEASES names no commit other than the one running (${CURRENT_SHA:-<none>}). The log only starts from the first deploy that wrote it; pass --to=<sha> to name a commit directly."
  DEPLOY_REF="$ROLLBACK_SHA"
  EXPLICIT_REF=1
  log "rolling back from ${CURRENT_SHA:0:7} to ${ROLLBACK_SHA:0:7}"
  log "NOTE: the schema is NOT rolled back. Migrations are forward-only and additive, so the older code runs against the newer schema — which is the designed case, but any migration in between is still applied."
fi

SHA="$($GIT rev-parse --verify --quiet "${DEPLOY_REF}^{commit}" || true)"
[[ -n "$SHA" ]] || die "could not resolve '${DEPLOY_REF}' to a commit in the local checkout — a rollback ships from *this* clone, so the commit has to be here. Try 'git fetch' first."

# A dirty tree is refused rather than warned about. The archive is built from
# HEAD, so uncommitted work is silently *not* deployed while BUILD_SHA claims
# the commit — the deployer's mental model and the host disagree, and /health
# reports the wrong answer with full confidence.
#
# Skipped when a ref was named explicitly: the worktree is then not the source
# of the archive under anybody's reading, so there is no mental model for it to
# disagree with. Refusing here would mean a dirty checkout cannot roll back,
# which is precisely the situation in which one is most needed.
if [[ "$ALLOW_DIRTY" -eq 0 && "$EXPLICIT_REF" -eq 0 ]]; then
  if [[ -n "$($GIT status --porcelain)" ]]; then
    die "working tree is dirty — commit, stash, or pass --allow-dirty (the archive is built from HEAD, so uncommitted changes would NOT be deployed while BUILD_SHA claims this commit)"
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
$GIT archive --format=tar.gz -o "$TARBALL" "$SHA"
log "archive: $(wc -c <"$TARBALL" | tr -d ' ') bytes"

# Read before unpacking, not after. The host's BUILD_SHA is the only trustworthy
# record of what is running there, and unpacking is the one step that can destroy
# it: `git archive` carries tracked files, so for as long as BUILD_SHA was one,
# `tar` wrote the committed SHA over the host's and section 3 read back a value
# the deploy had itself just supplied. It is untracked now (see .gitignore, and
# .gitattributes for the belt to that braces), which is the actual fix — this
# ordering is what makes the sweep correct by construction rather than by the
# continued absence of a file from an archive.
PREV_SHA="$(run_remote "cat $REMOTE_DIR/BUILD_SHA 2>/dev/null || true" | tr -d '[:space:]' || true)"

if [[ "$APPLY" -eq 1 ]]; then
  $SCP ${KEY_ARGS[@]+"${KEY_ARGS[@]}"} "$TARBALL" "$HOST:/tmp/n409-deploy.tar.gz"
else
  printf '  [dry-run] scp %s %s:/tmp/n409-deploy.tar.gz\n' "$TARBALL" "$HOST_DISPLAY" >&2
fi
run_remote "cd $REMOTE_DIR && tar -xzf /tmp/n409-deploy.tar.gz && rm -f /tmp/n409-deploy.tar.gz"

# ── 3. Remove what the commit removed ────────────────────────────────────────
# tar never deletes. Files dropped since the deployed commit would otherwise
# stay live forever — including routes and migrations that were deliberately
# withdrawn.
if [[ -n "$PREV_SHA" && "$PREV_SHA" != "unknown" ]] && $GIT cat-file -e "${PREV_SHA}^{commit}" 2>/dev/null; then
  # -z into a file, not newlines into a variable. `--name-only` alone C-quotes
  # any path that is not plain ASCII — `café.txt` comes back as the seven
  # literal characters `"caf\303\251.txt"`, quotes included — so the sweep would
  # ask the host to remove a filename that has never existed and `rm -f` would
  # agree, silently. -z emits raw bytes and never quotes; it needs a file
  # because bash cannot hold a NUL in a variable at all.
  DELETED_LIST="$(mktemp "${TMP_ROOT%/}/n409-deleted-XXXXXX")"
  # "$SHA", not HEAD. They are the same thing for an ordinary deploy and they
  # are not for a rollback, where HEAD is the release being *undone*. Diffing to
  # HEAD there computes the deletions of a commit that is not being shipped —
  # which for a rollback is usually the empty set — so every file the newer
  # release added would survive the sweep and stay live under the older code.
  # That is the exact "tar never deletes" failure this sweep exists to prevent,
  # reappearing on the one path taken when production is already broken.
  $GIT diff --diff-filter=D --name-only -z "$PREV_SHA" "$SHA" >"$DELETED_LIST" || true
  DELETED_COUNT="$(tr -cd '\0' <"$DELETED_LIST" | wc -c | tr -d ' ')"
  if [[ "$DELETED_COUNT" -gt 0 ]]; then
    log "removing ${DELETED_COUNT} file(s) deleted since ${PREV_SHA:0:7}"
    while IFS= read -r -d '' f; do
      [[ -n "$f" ]] || continue
      # The host's BUILD_SHA is never ours to remove. It is a record of the
      # release the host is running, not a file the tree provides, and the sweep
      # is the one place that could mistake the two: untracking it is itself a
      # deletion, so the first deploy after that change asks to delete exactly
      # the file section 6 exists to write. Harmless when the build then
      # succeeds and fatal to the evidence when it does not — the deploy would
      # abort having already erased what the host was running.
      # RELEASES joins it for the same reason and one more: it is the only
      # record of what has run, so deleting it does not merely lose evidence,
      # it disarms --rollback.
      if [[ "$f" == "BUILD_SHA" || "$f" == "RELEASES" ]]; then continue; fi
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

# 4a. …and then check that the venvs actually contain what the spec asks for.
#
# Unconditional, which is the point: the block above installs only when
# requirements.txt *changed*, so the case this catches is precisely the one it
# skips. A venv installed months ago holds whatever PyPI served that day, and
# nothing since has compared it to the spec — CI cannot, because `pip-audit -r`
# resolves the floors afresh and audits versions that exist on no host.
#
# That gap had a live instance: the ai venv sat at pypdf 6.14.2, carrying two
# advisories reachable from an unauthenticated document upload, while CI's
# dependency scan was green. Raising the floor retires it (the diff above
# reinstalls), but only this line notices the *next* one.
#
# Fatal, like the build and the preflight, and for the same reason: a deploy
# that fails here leaves the previous release serving, which is strictly better
# than restarting into a venv nobody can describe. SKIP_PREFLIGHT covers it too
# — the escape hatch for a host that needs a deploy more than it needs a
# correct one.
if [[ "${SKIP_PREFLIGHT:-0}" == "1" ]]; then
  log "SKIP_PREFLIGHT=1 — not checking the host's venvs against requirements.txt"
else
  for svc in ai engine-wrapper; do
    log "checking $svc venv against requirements.txt"
    run_remote "cd $REMOTE_DIR && src/services/$svc/.venv/bin/python tools/check_installed_deps.py src/services/$svc/requirements.txt" \
      || die "$svc: the host's venv does not satisfy its requirements.txt — nothing was restarted, the previous release is still serving. Run '.venv/bin/pip install -r requirements.txt' in $REMOTE_DIR/src/services/$svc (SKIP_PREFLIGHT=1 overrides)"
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
  #
  # --install-dir is passed twice, naming the same two directories
  # infra/install-units.sh installs from. That is the scope of the memory-ceiling
  # sweep added in round 99, and it is wider than --unit-dir on purpose: the two
  # backup units are installed onto this host by the same script and share its
  # RAM with the five services, but they were outside every check in this file
  # until now — installed by the deploy, validated by nothing.
  run_remote "cd $REMOTE_DIR/src/services/valuation && node dist/preflight-cli.js --env-file $REMOTE_DIR/.env --unit-dir $REMOTE_DIR/infra/systemd --install-dir $REMOTE_DIR/infra/systemd --install-dir $REMOTE_DIR/infra/backup" \
    || die "the host's configuration would be rejected at boot — nothing was restarted, the previous release is still serving. Fix $REMOTE_DIR/.env and deploy again (SKIP_PREFLIGHT=1 overrides, which trades a failed deploy for a failed service)"

  # The Python pair validates its own tunables — body caps, threadpool sizes,
  # rate ceilings, the OpenRouter budgets — and refuses a production boot on a
  # value it cannot parse. `preflight-cli.js` cannot cover them: Node cannot
  # import a Python module, and transcribing the specs into TypeScript would
  # leave two lists to keep in step. So each service is asked directly, in the
  # interpreter that will enforce the answer, which is why there is nothing here
  # that can drift from what the service actually does at boot.
  for svc in ai engine-wrapper; do
    log "validating $REMOTE_DIR/.env against the $svc start-up guards"
    run_remote "cd $REMOTE_DIR/src/services/$svc && .venv/bin/python -m app.config_check --env-file $REMOTE_DIR/.env" \
      || die "the host's configuration would be rejected by the $svc service at boot — nothing was restarted, the previous release is still serving. Fix $REMOTE_DIR/.env and deploy again (SKIP_PREFLIGHT=1 overrides, which trades a failed deploy for a failed service)"
  done
fi

# ── 4c. Install the systemd units ────────────────────────────────────────────
#
# `git archive` has always carried infra/systemd/ and infra/backup/ onto the
# host, and systemd has never read them: it reads /etc/systemd/system. Nothing
# connected the two but a human with scp, so the units on the box were four
# weeks behind the repo and one of the lines that had not travelled was
# engine-wrapper's `Environment=APP_ENV=production` — the switch that makes its
# INTERNAL_SERVICE_TOKEN guard mandatory rather than advisory. See
# infra/install-units.sh for the whole failure.
#
# After preflight, because preflight validates the unit files this step is about
# to install, and before section 6, because that is what restarts the services
# into them. Fatal, like the build and the preflight above: a host whose units
# could not be written must keep serving the old release rather than restart
# into a set of units nobody can name.
run_remote "cd $REMOTE_DIR && bash infra/install-units.sh" \
  || die "could not install the systemd units on the host — nothing was restarted, the previous release is still serving"

# ── 4c2. Bound the journal ───────────────────────────────────────────────────
#
# The other half of 4c's problem. Every service here logs to stdout and systemd
# puts that in the journal — DEPLOYMENT.md says so, and then tells an operator
# to read the journal after an OOM kill. How large that journal may grow, how
# long it is kept, and whether it survives a reboot were the distro's defaults,
# recorded in this repo nowhere at all. On a single-disk host an unbounded
# journal is an outage whose first symptom is Postgres refusing writes, and a
# journal that turns out to have been volatile is an incident with no evidence.
#
# Unlike the Caddyfile below, this one *can* be installed: journald.conf.d is a
# drop-in directory, our file is ours alone, and the bound it sets is one the
# other two products on the box want too.
#
# Fatal, and after 4c so the two systemd-facing steps stay together. The script
# does not stop at writing the file — it asks systemd what journald's effective
# configuration is and fails if our values are not the ones in force, because a
# drop-in that a later-sorting file overrides looks identical on disk to one
# that is working. See infra/install-journald.sh.
if [[ "${SKIP_JOURNALD:-0}" == "1" ]]; then
  log "SKIP_JOURNALD=1 — not installing the journald drop-in"
else
  run_remote "cd $REMOTE_DIR && bash infra/install-journald.sh" \
    || die "could not put the journald limits in force on the host — nothing was restarted, the previous release is still serving (SKIP_JOURNALD=1 overrides)"
fi

# ── 4d. Check the edge config, which cannot be installed ─────────────────────
#
# `infra/caddy/` is the last copy of 4c's failure still open: shipped onto the
# host by every deploy and read by nobody, because Caddy reads
# /etc/caddy/Caddyfile.
#
# It cannot be closed the same way. That one Caddyfile also serves two unrelated
# products from the same ports, so copying ours over it would take them down —
# which is why the repo holds the n409 *site block* rather than a config, and
# why this reports rather than installs.
#
# Fatal anyway, and that is the deliberate part: a report about an edge config
# that only warns is a warning nobody reads, and the two things it compares are
# the two that fail silently in production. A dropped trusted-proxy range leaves
# the site up and every per-IP throttle keyed on a Cloudflare POP; a `/scim/v2/*`
# handle that stops preceding the catch-all 404s an IdP's provisioning job in
# somebody else's logs. Neither shows up in section 7's verification, because
# both serve 200s.
#
# The comparison is on what Caddy would do, not on bytes — the host's copy is
# indented differently and carries its own comments — so this does not fail on
# formatting. See infra/check-caddy.mjs.
if [[ "${SKIP_CADDY_CHECK:-0}" == "1" ]]; then
  log "SKIP_CADDY_CHECK=1 — not comparing the host's Caddy config with this checkout"
else
  run_remote "cd $REMOTE_DIR && node infra/check-caddy.mjs" \
    || die "the host's Caddy config does not match this checkout — nothing was restarted, the previous release is still serving. Fix /etc/caddy/Caddyfile as printed above (edit the block in place; the file is shared with other sites) and deploy again (SKIP_CADDY_CHECK=1 overrides)"
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

# ── 8. Record the release, so the next rollback has a target ─────────────────
#
# Appended here and nowhere earlier: this line is the definition of "a release
# that worked", and every `die` above this point leaves the previous release
# serving. A SHA written before verification would name a commit that never
# successfully served, and `--rollback` would then roll *forward* into it — the
# one thing a rollback must never do.
#
# BUILD_SHA answers "what is running"; this answers "what has run". They are
# different questions and a single file cannot hold both: BUILD_SHA is
# overwritten on every deploy, so by the time anyone wants the previous release
# it has already been destroyed by the deploy they want to undo.
#
# Append-only, never rewritten, and deliberately not truncated — it is a few
# dozen bytes per deploy, and the entry someone needs is exactly the old one.
#
# A rollback is deliberately NOT recorded. The log is a history of releases as
# they were rolled *out*, and a rollback returns to a point that is already in
# it. Appending would put the older commit at the newest end, and the walk-back
# in section 1b — which reads position, not recency — would then resolve the
# next rollback to the release that was just undone. Not appending is what makes
# repeated rollbacks step backwards through the history instead of oscillating
# between the last two entries.
if [[ "$ROLLBACK" -eq 1 ]]; then
  log "not recording a release: this was a rollback to $SHA, which the log already holds"
else
  run_remote "printf '%s\t%s\n' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" $SHA >> $REMOTE_DIR/RELEASES \
    && chown $SERVICE_USER:$SERVICE_USER $REMOTE_DIR/RELEASES"
fi

log "deployed $SHA and verified live"
