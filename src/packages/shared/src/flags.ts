/**
 * Feature flags: the switch that turns a bad round into a restart.
 *
 * The three mechanisms this file was written for — the circuit breakers on the
 * internal clients, the retry ladders, and the backup verification timer — all
 * landed in the last few rounds, all sit on the path of every valuation, and
 * all have the same failure signature: when they misbehave they do it by
 * *refusing work that would have succeeded*. A breaker with a threshold set too
 * low reports an upstream as dead while it is merely slow. A retry ladder with
 * a backoff set too long holds a queue. Neither crashes, so neither is caught by
 * a health check, and the only remedy available today is a revert-and-redeploy
 * — a build, a `git archive`, five restarts, and however long it takes someone
 * to be sure which commit to revert to.
 *
 * A flag makes that remedy an edit to `/opt/N409/.env` and a `systemctl
 * restart`. That is the whole ambition here; it is deliberately not a
 * percentage-rollout or per-tenant targeting system, because nothing in this
 * deployment can use one. There is a single process per service on a single
 * host, so "10% of traffic" has no implementation that is not a coin flip per
 * request, and a coin flip is the wrong shape for a breaker whose entire job is
 * to remember what happened on the previous request.
 *
 * ## Every default is `true`, and that is the load-bearing decision
 *
 * These features are *already deployed*. A flag system whose defaults were
 * `false` — the natural reading of "control rollout of new features" — would,
 * on the deploy that introduced it, silently switch off the breakers, the retry
 * ladders and the backup verification on a production host where all three are
 * currently working. The flags would have caused precisely the outage they
 * exist to shorten.
 *
 * So these are kill switches, not rollout gates: the default is the behaviour
 * that is live today, and setting a flag is how an operator *departs* from it.
 * The direction matters more than it looks, because it also decides what an
 * unset variable means, and unset is the state of every variable on a host
 * nobody has touched — including a freshly provisioned one.
 *
 * A genuinely new feature can still be introduced dark by declaring it with
 * `default: false`; the registry is per-flag, and nothing here assumes the
 * three below are the only shape.
 *
 * ## Read per call, not cached at import
 *
 * `flagEnabled` reads `process.env` every time. That costs a property lookup
 * and a small parse, against a saving no profile would show, and it buys two
 * things worth more: a test can set a variable and see the effect without
 * module-registry surgery, and there is no window in which a module imported
 * before the environment was assembled captures the wrong answer forever. The
 * engine's `ENGINE_LIVE_UNIVERSE` is read per call for the same reason, and its
 * comment makes the same argument.
 */

/** A single declared flag. */
export interface FlagSpec {
  /** Stable slug used in logs and in `flagSnapshot`. */
  readonly name: string;
  /** The environment variable that sets it. */
  readonly env: string;
  /**
   * The value used when the variable is unset — or set to something
   * unparseable, which the preflight refuses at deploy time.
   *
   * For everything currently in the registry this is `true`, because every
   * entry describes behaviour already running in production. See the header.
   */
  readonly default: boolean;
  /** What turning it off actually does. Read by operators, so it says the consequence. */
  readonly description: string;
}

/**
 * Values accepted as "on" and "off".
 *
 * Generous on input because the audience is a human editing `.env` over ssh,
 * and `FLAG_X=off` failing while `FLAG_X=false` works is the kind of papercut
 * that gets discovered during an incident. Everything outside these two lists
 * is a *problem* rather than a third meaning — see `parseFlagValue`.
 */
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

/**
 * `true`/`false` for a recognised value, `null` for one nothing can read.
 *
 * `null` rather than a silent fallback because the two failure directions are
 * not symmetric. An operator who writes `FLAG_CIRCUIT_BREAKERS=disable` (no
 * `d`) means to turn something off; a parser that shrugged and returned the
 * default would leave it on and report success, and the operator would go on
 * believing the switch had been thrown. So the unreadable value is surfaced —
 * `flagProblems` collects them and `infra/deploy.sh` refuses the deploy — while
 * `flagEnabled` still has to answer *something* at runtime, and answers with
 * the default, which is the currently-shipping behaviour.
 */
export function parseFlagValue(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return null;
}

/**
 * The flags this platform declares.
 *
 * A registry rather than free-form string lookups so that the set is
 * enumerable: `flagSnapshot` can report all of them at boot, `flagProblems` can
 * validate all of them before a deploy restarts anything, and
 * `envExample.test.ts` can insist every one of them is documented. A
 * `flagEnabled('typo_here')` cannot happen, because the argument is a spec and
 * not a string.
 */
export const FLAGS = {
  /**
   * `clients/internal.ts` — the breaker around every engine and AI call.
   *
   * Off, `postJson` dials on every call regardless of how the last few went.
   * That is the pre-breaker behaviour, and the reason to want it back is a
   * breaker that has opened against an upstream which is actually fine: the
   * platform then reports features unavailable that would have worked, and no
   * amount of waiting fixes it because the probe traffic is what is being
   * refused.
   *
   * Note what stays on: the retry ladder, the deadline, and the failure
   * classification are all independent of this. Turning this off removes the
   * memory between calls, nothing else.
   */
  circuitBreakers: {
    name: 'circuit_breakers',
    env: 'FLAG_CIRCUIT_BREAKERS',
    default: true,
    description:
      'Circuit breakers on the internal engine/AI clients. Off: every call is dialled, with no memory of recent failures.',
  },

  /**
   * The in-request retry in `postJson`, and the persisted ladders behind the
   * email outbox (migration 0159) and pipeline runs (0161).
   *
   * Off, a transient failure surfaces immediately as a failure instead of being
   * re-attempted. The reason to want that is a retry storm: a ladder pointed at
   * a dependency that is failing *slowly* multiplies load on the thing least
   * able to take it, and the queue drains into the same wall repeatedly.
   *
   * This does not abandon queued work — rows keep their state and their
   * attempt counters, so the ladders resume where they stopped when the flag
   * goes back on. It stops the re-dialling, not the bookkeeping.
   */
  retryLadders: {
    name: 'retry_ladders',
    env: 'FLAG_RETRY_LADDERS',
    default: true,
    description:
      'Automatic retries: in-request (internal clients) and persisted (email outbox, pipeline runs). Off: a transient failure is reported rather than re-attempted.',
  },

  /**
   * `infra/backup/pg-verify.sh`, run by `n409-backup-verify.timer`.
   *
   * Off, the nightly dump is still taken — this flag does not touch
   * `n409-backup.timer` — but nothing restores it to prove it can be restored.
   * The reason to want that is narrow and real: the verification restores into
   * a scratch database on the same host, and if that host is short of disk or
   * IO the verification is the one thing here that can be dropped without
   * losing data.
   *
   * It is the flag most worth turning back on promptly, since what it buys
   * while off is a backup nobody has tested — which is the exact state the
   * verification job was written to end.
   */
  backupVerification: {
    name: 'backup_verification',
    env: 'FLAG_BACKUP_VERIFICATION',
    default: true,
    description:
      'Nightly restore-test of the Postgres dump. Off: dumps are still taken, but never proven restorable.',
  },
} as const satisfies Record<string, FlagSpec>;

export type FlagName = keyof typeof FLAGS;

/** The environment a flag is read from. Injectable so tests never touch the real one. */
export type FlagEnv = Record<string, string | undefined>;

/**
 * Is `spec` on?
 *
 * An unparseable value yields the default rather than throwing: this is called
 * on the request path, and a flag misconfiguration must not become a 500 on
 * every route. The loud half of that bargain is `flagProblems`, which runs
 * before a deploy is allowed to restart anything.
 */
export function flagEnabled(spec: FlagSpec, env: FlagEnv = process.env): boolean {
  return parseFlagValue(env[spec.env]) ?? spec.default;
}

/**
 * Every declared flag and its effective value — for a boot log line and for
 * `/health`-adjacent diagnostics.
 *
 * The point of emitting this at boot is that "which flags are set" is otherwise
 * answerable only by reading a file on the host, and the question is always
 * asked during an incident, when the answer is most likely to be wrong and
 * least likely to be checked.
 */
export function flagSnapshot(env: FlagEnv = process.env): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const spec of Object.values(FLAGS)) out[spec.name] = flagEnabled(spec, env);
  return out;
}

/** Declared flags whose value is set but unreadable, as operator-facing prose. */
export function flagProblems(env: FlagEnv = process.env): string[] {
  const problems: string[] = [];
  for (const spec of Object.values(FLAGS)) {
    const raw = env[spec.env];
    // Empty is "not configured", not "configured wrongly" — and the difference
    // is not academic: `.env.example` is a template that ships every optional
    // setting as a bare `NAME=`, flags included, so treating an empty value as
    // a fault would fail the preflight on every host built the documented way.
    // The whole file is full of `XERO_CLIENT_ID=` lines meaning exactly this.
    if (raw === undefined || raw.trim() === '') continue;
    if (parseFlagValue(raw) === null) {
      problems.push(
        `${spec.env}: ${JSON.stringify(raw)} is not a boolean — use one of ` +
          `${[...TRUE_VALUES].join('/')} or ${[...FALSE_VALUES].join('/')} ` +
          `(unset means ${spec.default})`,
      );
    }
  }
  return problems;
}

/** Flags currently departing from their default — the short list worth logging. */
export function flagOverrides(env: FlagEnv = process.env): string[] {
  return Object.values(FLAGS)
    .filter((spec) => flagEnabled(spec, env) !== spec.default)
    .map((spec) => spec.name);
}
