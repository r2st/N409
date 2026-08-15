/**
 * Prove the dependencies are there before saying the service is.
 *
 * A process that boots, binds a port and answers `/ready` with 200 while
 * Postgres is still starting is not ready — it is a service that will 500 every
 * request it is given for the next thirty seconds. That window is invisible in
 * the ordinary case, because a deploy restarts the service long after the
 * database has been up for weeks. It is exactly the case that matters during a
 * host reboot or a docker-compose cold start, when everything comes up at once
 * and the order is whatever systemd decided.
 *
 * Two separate mechanisms here, because "wait for it" and "tell the load
 * balancer" are different problems:
 *
 *  - {@link awaitDependencies} blocks the boot until the *required* dependencies
 *    answer, with a bounded ladder and a hard deadline. This is what stops a
 *    service from listening at all before it can serve.
 *  - {@link StartupGate} is a readiness check that reports not-ready until boot
 *    completes. This is what stops traffic from being routed to a process that
 *    is listening but still migrating.
 *
 * The second one exists because the first cannot cover everything. Migrations
 * run *after* the port is bound in some services and take as long as they take;
 * a `/ready` that went green the moment the socket opened would route traffic
 * into the middle of them.
 *
 * ## Required vs optional
 *
 * Not every dependency deserves to block a boot. Postgres does: without it this
 * service can do nothing at all, and coming up to serve 500s helps nobody. The
 * AI service does not: with it down the platform still lists valuations, still
 * renders reports, still takes payments — everything except the one feature
 * that needs a model. Blocking the boot on it converts a degraded feature into
 * a total outage, which is the failure this whole hardening round is against.
 * So an optional dependency is probed, its failure is logged loudly, and the
 * boot continues.
 */

import { backoffDelayMs, classifyFailure } from './failure.js';

export interface DependencyCheck {
  /** Name reported in logs and in the result — `postgres`, `ai`. */
  name: string;
  /** Throws (or rejects) when the dependency is not usable. */
  probe: () => Promise<void>;
  /**
   * False when the service can run without it. Optional dependencies are
   * probed and reported, never waited on past their first failure.
   */
  required?: boolean;
}

export interface DependencyOutcome {
  name: string;
  required: boolean;
  ok: boolean;
  /** Attempts made, including the successful one. */
  attempts: number;
  /** Scrubbed failure message, when it never came up. */
  error: string | null;
}

export interface AwaitDependenciesOptions {
  checks: DependencyCheck[];
  /**
   * Total wall-clock budget for the required dependencies (ms). On expiry
   * `awaitDependencies` gives up and reports, and the caller decides whether
   * that is fatal — which it should be.
   */
  timeoutMs?: number;
  /** First retry delay; doubles, jittered (see `backoffDelayMs`). */
  baseDelayMs?: number;
  /** Ceiling on any single delay. */
  maxDelayMs?: number;
  log?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
  /** Injectable sleep + clock, so tests need no elapsed time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Injectable jitter source, so a test can assert the ladder exactly. */
  random?: () => number;
}

export interface AwaitDependenciesResult {
  ok: boolean;
  outcomes: DependencyOutcome[];
  /** Required dependencies that never came up. */
  missing: string[];
  /** Optional dependencies that never came up — the degraded set. */
  degraded: string[];
  elapsedMs: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe every dependency, retrying the required ones until they answer or the
 * budget runs out.
 *
 * Never throws: a dependency that is down is a *result*, and the boot script
 * reads it and decides. Throwing here would make the interesting case — which
 * things are missing — the one the caller has to dig out of an exception.
 *
 * Optional dependencies get exactly one attempt. Retrying them would spend the
 * boot's budget on something that was never going to block it, and the ordinary
 * reason one is down (an OpenRouter outage) lasts far longer than any boot.
 */
export async function awaitDependencies(opts: AwaitDependenciesOptions): Promise<AwaitDependenciesResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;

  const outcomes = await Promise.all(
    opts.checks.map(async (check): Promise<DependencyOutcome> => {
      const required = check.required !== false;
      let attempts = 0;
      let lastError: string | null = null;

      for (;;) {
        attempts += 1;
        try {
          await check.probe();
          if (attempts > 1) {
            log?.info({ dependency: check.name, attempts }, 'dependency became available');
          }
          return { name: check.name, required, ok: true, attempts, error: null };
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          const failure = classifyFailure(err);

          // One attempt for an optional dependency; see the note above.
          if (!required) {
            log?.warn(
              { dependency: check.name, err, failure_reason: failure.reason },
              'optional dependency is unavailable — starting in degraded mode',
            );
            return { name: check.name, required, ok: false, attempts, error: lastError };
          }

          // A permanent failure will not pass by waiting. A wrong password or a
          // database that does not exist is not a cold start, and spending the
          // full budget on it delays the only useful outcome — the boot failing
          // with the reason in hand — by exactly `timeoutMs`.
          if (failure.kind === 'permanent') {
            log?.error(
              { dependency: check.name, err, failure_reason: failure.reason, alert: true },
              'required dependency failed permanently — not retrying',
            );
            return { name: check.name, required, ok: false, attempts, error: lastError };
          }

          const delay = backoffDelayMs(attempts - 1, {
            baseMs: opts.baseDelayMs ?? 250,
            maxMs: opts.maxDelayMs ?? 5_000,
            random: opts.random,
          });
          if (now() + delay >= deadline) {
            log?.error(
              { dependency: check.name, attempts, err, alert: true },
              'required dependency did not become available within the startup budget',
            );
            return { name: check.name, required, ok: false, attempts, error: lastError };
          }
          log?.warn(
            { dependency: check.name, attempts, delayMs: delay, err },
            'dependency not ready yet — retrying',
          );
          await sleep(delay);
        }
      }
    }),
  );

  const missing = outcomes.filter((o) => o.required && !o.ok).map((o) => o.name);
  const degraded = outcomes.filter((o) => !o.required && !o.ok).map((o) => o.name);
  return { ok: missing.length === 0, outcomes, missing, degraded, elapsedMs: now() - startedAt };
}

/**
 * A readiness check that fails until the boot says otherwise.
 *
 * Registered alongside the dependency checks in `registerHealth`, so `/ready`
 * is red — and the load balancer keeps traffic away — for the whole window
 * between the port binding and the service actually being able to serve.
 */
export class StartupGate {
  private open = false;
  private failure: string | null = null;

  constructor(private readonly service: string) {}

  /** Boot finished. `/ready` may now go green if the dependencies agree. */
  markReady(): void {
    this.open = true;
    this.failure = null;
  }

  /**
   * Boot failed in a way the process survived. Readiness stays red and says so
   * — to the log and to a token-holding operator, never to the public body
   * (see `registerHealth`).
   */
  markFailed(reason: string): void {
    this.open = false;
    this.failure = reason;
  }

  get ready(): boolean {
    return this.open;
  }

  /** The `ReadinessCheck` shape: resolves when open, throws when not. */
  readonly check = async (): Promise<void> => {
    if (this.open) return;
    throw new Error(
      this.failure ?? `${this.service} is still starting up — dependencies have not been verified yet`,
    );
  };
}
