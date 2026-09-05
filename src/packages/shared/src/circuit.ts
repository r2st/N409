/**
 * Stop calling a dependency that is not answering.
 *
 * The retry ladder in `postJson` is the right thing to do to *one* request
 * against a dependency that is briefly unwell. It is the wrong thing to do to
 * every request against a dependency that is down, and the difference is not
 * visible from inside any single call — which is why a breaker has to be a
 * separate object with memory rather than another branch in the retry loop.
 *
 * Concretely, with the AI service down and nothing but retries in front of it:
 * every pipeline request spends its full budget (two attempts plus backoff)
 * discovering the same refused connection, and holds a Fastify handler, a
 * request-scoped log context and whatever it was carrying for the whole
 * duration. The requests do not fail faster as things get worse — they fail
 * *slower*, because the deadline is the only thing bounding them. A hundred
 * users clicking "generate" during an OpenRouter outage is a hundred handlers
 * sitting on their hands, and the service that was merely missing one feature
 * is now unable to serve the pages that never needed it. That is the cascade,
 * and the fix is to stop dialling.
 *
 * ## Only transient failures open it
 *
 * A breaker that counts every failure gets opened by the callers' own mistakes:
 * a run of 422s from malformed payloads is not the dependency being unhealthy,
 * and shutting off a working service because clients are sending it rubbish is
 * a self-inflicted outage. So `record` takes a classification (see
 * `failure.ts`) and only `transient` counts toward tripping. A permanent
 * failure leaves the breaker exactly as it found it.
 *
 * ## Half-open is a single probe, not an opening of the floodgates
 *
 * When the cooldown expires the breaker does not close — it lets a bounded
 * number of trial calls through and closes only if one succeeds. Closing
 * optimistically at the end of a timer is how a breaker turns into a
 * synchronised retry wave against a dependency that is still on its knees.
 */

import type { FailureClass } from './failure.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * What {@link CircuitBreaker.acquire} hands back, and what a settle passes in
 * to say *which call* is reporting (R440, methodology M3).
 *
 * A breaker's inputs are `recordSuccess` and `recordFailure`, and without this
 * they are anonymous: the breaker cannot tell the verdict of the trial call it
 * admitted a moment ago from the verdict of a call it admitted a minute ago,
 * while it was still closed, which has only now finished. Those stragglers are
 * not exotic — this file already says so about `openedBy` ("a success can
 * arrive while the breaker is open: the call that reports it was admitted
 * before the trip and finished after it") and `reportRender.ts` says it again
 * about its own queue ("the wait this timed out on is the tail of the previous
 * stall, held by requests issued before the trip"). Every concurrent caller in
 * flight at the moment of a trip becomes one.
 *
 * Read as verdicts about the present, they break the two things the open and
 * half-open states are for:
 *
 *   * THE COOLDOWN NEVER STARTS. A straggler's transient failure arriving
 *     while the breaker is open re-reached the failure threshold — the tally
 *     is already past it — and re-tripped, which restamps `openedAt`. A queue
 *     of requests draining against a dead dependency therefore pushed the
 *     first trial call out by one full `resetTimeoutMs` past the *last* of
 *     them, not past the trip. For the report offload, where the fallback is
 *     an in-process render costing orders of magnitude more than the delegated
 *     one, that is the expensive path staying on long after the unit is back.
 *
 *   * THE SINGLE PROBE IS NOT SINGLE. Any settle arriving while the breaker is
 *     half-open decremented `halfOpenInFlight` — a counter the straggler never
 *     incremented, because it was admitted while the breaker was closed. So a
 *     straggler hands out a second trial slot beside the live probe (the
 *     thundering herd `acquire` exists to prevent), and its verdict is read as
 *     the probe's: a straggler failure re-opens the breaker and discards the
 *     real trial, whose success then lands on an `open` breaker and closes
 *     nothing.
 *
 * The `episode` is the fix and it is one integer: it moves every time the
 * breaker opens, so a call admitted before the trip carries a number the
 * breaker has moved past. Such a settle changes no state at all — it is
 * evidence about a period that is over.
 *
 * A settle with NO ticket keeps the old behaviour, and that is deliberate
 * rather than a compatibility shim: `postJson` and the report client record
 * their outcomes even when `FLAG_CIRCUIT_BREAKERS` is off, without acquiring
 * anything, precisely so a breaker switched off "still watches and comes back
 * warm". Those settles have no provenance to check, and reading them as
 * current is what keeps that true — a breaker that could never close while the
 * flag was off would come back open on a healthy dependency, which is worse
 * than coming back cold.
 */
export interface CircuitTicket {
  /** True when this call took the half-open trial slot. */
  readonly trial: boolean;
  /** The breaker's open-episode counter at the moment the call was admitted. */
  readonly episode: number;
}

/** Thrown instead of dialling, while the breaker is open. */
export class CircuitOpenError extends Error {
  readonly circuit: string;
  /** Milliseconds until the breaker will next allow a trial call. */
  readonly retryAfterMs: number;

  constructor(circuit: string, retryAfterMs: number) {
    super(`${circuit} is unavailable (circuit open)`);
    this.name = 'CircuitOpenError';
    this.circuit = circuit;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CircuitOptions {
  /** Name used in errors, logs and gauges — the dependency, e.g. `ai`. */
  name: string;
  /**
   * Consecutive transient failures that open the breaker. Consecutive rather
   * than a rate: a rate needs a window and a minimum sample size to not fire on
   * the first unlucky request after a quiet hour, and this service's traffic is
   * far too lumpy for that to be tuned once and left alone.
   */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing a trial call (ms). */
  resetTimeoutMs?: number;
  /** Trial calls admitted at once while half-open. */
  halfOpenMax?: number;
  /** Injectable clock, so tests need no elapsed time. */
  now?: () => number;
  /** Told on every state change. */
  onStateChange?: (change: { name: string; from: CircuitState; to: CircuitState; reason: string }) => void;
}

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  /** Consecutive transient failures since the last success. */
  consecutiveFailures: number;
  /** Milliseconds until the next trial call is allowed; 0 unless open. */
  retryAfterMs: number;
  /** Total calls refused without dialling, since boot. */
  rejected: number;
  /** Reason slug of the failure that opened it, or null. */
  openedBy: string | null;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private openedBy: string | null = null;
  private halfOpenInFlight = 0;
  private rejected = 0;
  /**
   * Which open-episode the breaker is in; moves on every trip and on a reset.
   * See {@link CircuitTicket} — this is the whole of the straggler fix.
   */
  private episode = 0;

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMax: number;
  private readonly now: () => number;
  private readonly onStateChange: CircuitOptions['onStateChange'];

  constructor(opts: CircuitOptions) {
    this.name = opts.name;
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? 5);
    this.resetTimeoutMs = Math.max(0, opts.resetTimeoutMs ?? 30_000);
    this.halfOpenMax = Math.max(1, opts.halfOpenMax ?? 1);
    this.now = opts.now ?? (() => Date.now());
    this.onStateChange = opts.onStateChange;
  }

  private transition(to: CircuitState, reason: string): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.onStateChange?.({ name: this.name, from, to, reason });
  }

  /** Milliseconds left on the cooldown; 0 when not open. */
  private cooldownRemaining(): number {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.resetTimeoutMs - (this.now() - this.openedAt));
  }

  /**
   * Move an expired `open` on to `half-open`. Called from both `allows` and
   * `snapshot` so an observer never reports a state the next call would not
   * actually act on.
   */
  private expireCooldown(): void {
    if (this.state === 'open' && this.cooldownRemaining() === 0) {
      this.halfOpenInFlight = 0;
      this.transition('half-open', 'cooldown elapsed');
    }
  }

  /** Whether a call may be attempted right now. Does not reserve a slot. */
  allows(): boolean {
    this.expireCooldown();
    if (this.state === 'closed') return true;
    if (this.state === 'open') return false;
    return this.halfOpenInFlight < this.halfOpenMax;
  }

  /**
   * Reserve the right to make a call, or throw {@link CircuitOpenError}.
   *
   * Separate from {@link allows} because the half-open slot has to be *taken*,
   * not merely observed: two concurrent callers both seeing "one trial allowed"
   * is two trial calls, which is the thundering herd the half-open state exists
   * to prevent.
   */
  acquire(): CircuitTicket {
    if (!this.allows()) {
      this.rejected += 1;
      throw new CircuitOpenError(this.name, this.cooldownRemaining());
    }
    const trial = this.state === 'half-open';
    if (trial) this.halfOpenInFlight += 1;
    // Handed back so the settle can say which call it is; see {@link CircuitTicket}.
    return { trial, episode: this.episode };
  }

  /**
   * Whether this settle is reporting on a period the breaker has moved past.
   *
   * A ticket from before the last trip is a call admitted under a different
   * regime — it answers "was the dependency well a minute ago", which is the
   * question the trip already answered. An absent ticket is not stale: see
   * {@link CircuitTicket} on the flag-off bookkeeping that has no ticket to
   * carry.
   */
  private isStale(ticket?: CircuitTicket): boolean {
    return ticket !== undefined && ticket.episode !== this.episode;
  }

  /**
   * Whether this settle is the verdict of a trial call the breaker is waiting
   * on — the only kind that may close a half-open breaker or re-open it.
   */
  private isTrialVerdict(ticket?: CircuitTicket): boolean {
    return this.state === 'half-open' && !this.isStale(ticket) && (ticket?.trial ?? true);
  }

  /** A call succeeded. Closes a half-open breaker and clears the tally. */
  recordSuccess(ticket?: CircuitTicket): void {
    // A success from a call admitted before the last trip is not proof of
    // recovery now — it is the tail of the outage that produced the trip. It
    // closed the breaker on no probe at all, which is the floodgate this state
    // exists to hold shut. See {@link CircuitTicket}.
    if (this.isStale(ticket)) return;
    if (this.isTrialVerdict(ticket)) {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.transition('closed', 'trial call succeeded');
    }
    this.consecutiveFailures = 0;
    /*
     * `openedBy` belongs to the open state, and only the close clears it.
     *
     * A success can arrive while the breaker is open: the call that reports it
     * was admitted before the trip and finished after it, which is the ordinary
     * shape of a dependency that is failing rather than dead. Cleared
     * unconditionally, that straggler left the breaker open with no reason on
     * it — and `openedBy` is exactly what `UpstreamCircuitOpen`'s runbook sends
     * an operator to read ("the breaker snapshot and what opened it"). The page
     * fires two minutes later and the one field that says why is null.
     *
     * Nothing else about the open state moves here either: a success that was
     * never admitted is not evidence the cooldown should end, which is what
     * {@link expireCooldown} is for.
     */
    if (this.state !== 'open') this.openedBy = null;
  }

  /**
   * Hand back a trial slot for a call that was never made.
   *
   * `acquire` takes the half-open slot *before* the work starts, so a caller
   * that gives up in between — its own budget spent queueing, a local
   * precondition it only discovers once it has the slot — is holding a probe it
   * cannot answer. Neither verdict fits: {@link recordSuccess} would close the
   * breaker on no evidence at all, and {@link recordFailure} re-opens it (a
   * permanent failure during a trial "says our request was wrong", and this
   * request was never sent), restarting the cooldown on the strength of
   * something that happened entirely inside this process — and naming the
   * dependency as the reason in the log and the state gauge.
   *
   * So the slot goes back and the state stays exactly as it was: still
   * half-open, still owed one real trial, which the next caller supplies.
   */
  releaseTrial(ticket?: CircuitTicket): void {
    // Only a slot this call actually took goes back. A straggler handing back a
    // probe it never held is how the live one comes to share the half-open
    // state with a second caller.
    if (this.isTrialVerdict(ticket)) this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
  }

  /**
   * A call failed. Only a `transient` classification counts toward opening —
   * see the header note.
   */
  recordFailure(failure: FailureClass, ticket?: CircuitTicket): void {
    // Same as the success above: a failure from before the trip is the outage
    // the breaker already opened on, arriving late. Counting it again re-trips
    // the breaker and restamps `openedAt`, so a queue of doomed requests
    // draining after the trip pushes the first trial call out past the *last*
    // of them. See {@link CircuitTicket}.
    if (this.isStale(ticket)) return;

    const trialFailed = this.isTrialVerdict(ticket);
    if (trialFailed) this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);

    if (failure.kind !== 'transient') {
      // A permanent failure during a trial call says nothing about the
      // dependency's health — it says our request was wrong. But it is also not
      // proof of recovery, so a half-open breaker must not close on it either;
      // it goes back to open and waits for a trial that actually answers.
      if (trialFailed) this.trip(failure.reason, 'trial call failed');
      return;
    }

    this.consecutiveFailures += 1;
    // The threshold arm is gated on `closed` because that is the only state it
    // is a decision in: an open breaker has already made it, and re-making it
    // is what moved the cooldown. The tally keeps counting either way — it is
    // "consecutive failures since the last success" and that stays true.
    if (trialFailed) this.trip(failure.reason, 'trial call failed');
    else if (this.state === 'closed' && this.consecutiveFailures >= this.failureThreshold)
      this.trip(failure.reason, 'failure threshold reached');
  }

  private trip(reason: string, why: string): void {
    // Every call admitted before this line now belongs to a period that is
    // over, and its ticket stops matching. See {@link CircuitTicket}.
    this.episode += 1;
    this.openedAt = this.now();
    this.openedBy = reason;
    this.halfOpenInFlight = 0;
    this.transition('open', `${why} (${reason})`);
  }

  /**
   * Run `fn` under the breaker.
   *
   * `classify` is passed in rather than imported so a caller with better
   * information than the shared table — `postJson`, which knows the HTTP status
   * — can supply it.
   */
  async run<T>(fn: () => Promise<T>, classify: (err: unknown) => FailureClass): Promise<T> {
    const ticket = this.acquire();
    try {
      const result = await fn();
      this.recordSuccess(ticket);
      return result;
    } catch (err) {
      this.recordFailure(classify(err), ticket);
      throw err;
    }
  }

  snapshot(): CircuitSnapshot {
    this.expireCooldown();
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      retryAfterMs: this.cooldownRemaining(),
      rejected: this.rejected,
      openedBy: this.openedBy,
    };
  }

  /** Force back to closed. For tests and for an operator override. */
  reset(): void {
    // An operator override is a new period as much as a trip is: calls that
    // were in flight under the state being overridden must not settle onto it.
    this.episode += 1;
    this.consecutiveFailures = 0;
    this.halfOpenInFlight = 0;
    this.openedBy = null;
    this.transition('closed', 'reset');
  }
}

/**
 * A registry of breakers by name, so every call site targeting one dependency
 * shares one piece of memory.
 *
 * A breaker per call site is not a breaker: five modules calling the AI service
 * each need five consecutive failures of their own before any of them stops,
 * and the one that is called rarely never trips at all.
 */
export class CircuitRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly defaults: Omit<CircuitOptions, 'name'> = {}) {}

  get(name: string, overrides: Omit<CircuitOptions, 'name'> = {}): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({ name, ...this.defaults, ...overrides });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  snapshots(): CircuitSnapshot[] {
    return [...this.breakers.values()].map((b) => b.snapshot());
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) breaker.reset();
  }
}
