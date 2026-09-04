// The breaker's whole value is in its state machine, and the state machine is
// driven by a clock — so every test here drives an injected one rather than
// waiting. The cases worth having are the ones where a naive implementation
// gets it wrong: a permanent failure opening the breaker for everyone, a
// half-open state admitting two callers at once, and a trial call that fails
// resetting the cooldown rather than closing it.
import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError, CircuitRegistry } from '../src/circuit.js';
import type { FailureClass } from '../src/failure.js';

const TRANSIENT: FailureClass = { kind: 'transient', reason: 'syscall.ECONNREFUSED', retryable: true };
const PERMANENT: FailureClass = { kind: 'permanent', reason: 'http.422', retryable: false };

/** A breaker on a clock the test moves by hand. */
function breakerAt(now: { ms: number }, opts: Record<string, unknown> = {}) {
  return new CircuitBreaker({
    name: 'ai',
    failureThreshold: 3,
    resetTimeoutMs: 30_000,
    now: () => now.ms,
    ...opts,
  });
}

describe('CircuitBreaker — opening', () => {
  it('stays closed until the threshold is reached, then refuses to dial', () => {
    const now = { ms: 0 };
    const breaker = breakerAt(now);

    breaker.recordFailure(TRANSIENT);
    breaker.recordFailure(TRANSIENT);
    expect(breaker.snapshot().state).toBe('closed');
    expect(breaker.allows()).toBe(true);

    breaker.recordFailure(TRANSIENT);
    expect(breaker.snapshot().state).toBe('open');
    expect(breaker.allows()).toBe(false);
    expect(() => breaker.acquire()).toThrow(CircuitOpenError);
  });

  it('does not open on permanent failures, however many', () => {
    // A run of 422s is clients sending rubbish, not the dependency being ill.
    // Opening here would shut off a working service because of its callers.
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    for (let i = 0; i < 20; i++) breaker.recordFailure(PERMANENT);
    expect(breaker.snapshot().state).toBe('closed');
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });

  it('counts consecutively — a success in between clears the tally', () => {
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    breaker.recordFailure(TRANSIENT);
    breaker.recordFailure(TRANSIENT);
    breaker.recordSuccess();
    breaker.recordFailure(TRANSIENT);
    breaker.recordFailure(TRANSIENT);
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('reports why it opened, and counts what it refused', () => {
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);
    expect(() => breaker.acquire()).toThrow();
    expect(() => breaker.acquire()).toThrow();
    expect(breaker.snapshot()).toMatchObject({
      state: 'open',
      openedBy: 'syscall.ECONNREFUSED',
      rejected: 2,
    });
  });

  it('reports how long is left on the cooldown', () => {
    const now = { ms: 1_000 };
    const breaker = breakerAt(now);
    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);
    now.ms += 10_000;
    expect(breaker.snapshot().retryAfterMs).toBe(20_000);
    try {
      breaker.acquire();
      throw new Error('expected the breaker to refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).retryAfterMs).toBe(20_000);
    }
  });
});

describe('CircuitBreaker — half-open', () => {
  it('admits exactly one trial call when the cooldown expires', () => {
    // Not "closes when the timer fires": closing optimistically is how a
    // breaker becomes a synchronised retry wave against a sick dependency.
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);

    now.ms += 30_000;
    expect(breaker.snapshot().state).toBe('half-open');

    breaker.acquire(); // the one trial call
    expect(breaker.allows()).toBe(false); // a second caller is still refused
    expect(() => breaker.acquire()).toThrow(CircuitOpenError);
  });

  it('closes when the trial call succeeds', () => {
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);
    now.ms += 30_000;
    breaker.acquire();
    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe('closed');
    expect(breaker.allows()).toBe(true);
  });

  it('re-opens on a single failed trial call, restarting the cooldown', () => {
    // One failure, not another three: the breaker already knows the dependency
    // is unwell, and the trial was the whole question.
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);
    now.ms += 30_000;
    breaker.acquire();
    breaker.recordFailure(TRANSIENT);

    expect(breaker.snapshot().state).toBe('open');
    expect(breaker.snapshot().retryAfterMs).toBe(30_000);
  });

  it('re-opens rather than closing when the trial call fails permanently', () => {
    // A 422 during a trial says nothing about the dependency's health — but it
    // is not proof of recovery either, so the breaker must not close on it.
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);
    now.ms += 30_000;
    breaker.acquire();
    breaker.recordFailure(PERMANENT);
    expect(breaker.snapshot().state).toBe('open');
  });

  it('hands the trial slot back when the call was never made', () => {
    // A caller that gives up between `acquire` and the request — its budget
    // spent queueing for a local resource — knows nothing about the
    // dependency. Recorded as a failure it re-opens the breaker and burns
    // another cooldown; recorded as a success it closes one on no evidence.
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);
    now.ms += 30_000;
    breaker.acquire();

    breaker.releaseTrial();

    // Still half-open, still owed a real trial — and the next caller can take
    // the slot the abandoned one gave back.
    expect(breaker.snapshot().state).toBe('half-open');
    expect(breaker.allows()).toBe(true);
    breaker.acquire();
    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('releaseTrial does nothing to a closed or open breaker', () => {
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    breaker.releaseTrial();
    expect(breaker.snapshot().state).toBe('closed');

    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);
    breaker.releaseTrial();
    expect(breaker.snapshot().state).toBe('open');
    expect(breaker.snapshot().retryAfterMs).toBe(30_000);
  });

  it('admits halfOpenMax trials when configured for more than one', () => {
    const now = { ms: 0 };
    const breaker = breakerAt(now, { halfOpenMax: 2 });
    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);
    now.ms += 30_000;
    breaker.acquire();
    breaker.acquire();
    expect(() => breaker.acquire()).toThrow(CircuitOpenError);
  });
});

describe('CircuitBreaker — a success that arrives after the trip', () => {
  it('keeps the reason the breaker is open', () => {
    // The call was admitted while the breaker was closed and finished after it
    // tripped, which is what a flapping dependency looks like from here.
    // `openedBy` is what `UpstreamCircuitOpen`'s runbook sends an operator to
    // read, and the page fires two minutes after the trip.
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);
    expect(breaker.snapshot().openedBy).toBe('syscall.ECONNREFUSED');

    breaker.recordSuccess();

    expect(breaker.snapshot().state).toBe('open');
    expect(breaker.snapshot().openedBy).toBe('syscall.ECONNREFUSED');
  });

  it('clears it once the breaker actually closes', () => {
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);
    now.ms += 30_000;
    breaker.acquire();
    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe('closed');
    expect(breaker.snapshot().openedBy).toBeNull();
  });
});

describe('CircuitBreaker — run()', () => {
  it('passes the result through and records the success', async () => {
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    await expect(
      breaker.run(
        async () => 'ok',
        () => TRANSIENT,
      ),
    ).resolves.toBe('ok');
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('rethrows the original error, not a breaker error', async () => {
    // The caller's error handling must keep working — the breaker is a
    // gatekeeper, not a replacement for what the dependency said.
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    const boom = new Error('upstream exploded');
    await expect(
      breaker.run(
        async () => Promise.reject(boom),
        () => TRANSIENT,
      ),
    ).rejects.toBe(boom);
  });

  it('fails fast once open, without invoking the function', async () => {
    const now = { ms: 0 };
    const breaker = breakerAt(now);
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error('down');
    };
    for (let i = 0; i < 3; i++) {
      await expect(breaker.run(fn, () => TRANSIENT)).rejects.toThrow('down');
    }
    expect(calls).toBe(3);

    // The fourth call must not reach the dependency at all. That is the whole
    // point: the requests stop costing a round trip and a held handler.
    await expect(breaker.run(fn, () => TRANSIENT)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(3);
  });

  it('reports state changes to the observer', () => {
    const changes: string[] = [];
    const now = { ms: 0 };
    const breaker = breakerAt(now, {
      onStateChange: (c: { from: string; to: string }) => void changes.push(`${c.from}->${c.to}`),
    });
    for (let i = 0; i < 3; i++) breaker.recordFailure(TRANSIENT);
    now.ms += 30_000;
    breaker.allows();
    breaker.acquire();
    breaker.recordSuccess();
    expect(changes).toEqual(['closed->open', 'open->half-open', 'half-open->closed']);
  });
});

describe('CircuitRegistry', () => {
  it('returns one breaker per name, so every call site shares the memory', () => {
    // A breaker per call site is not a breaker: each one needs its own run of
    // failures before it stops, and a rarely-called site never trips at all.
    const registry = new CircuitRegistry({ failureThreshold: 2 });
    const a = registry.get('ai');
    const b = registry.get('ai');
    expect(a).toBe(b);
    expect(registry.get('engine')).not.toBe(a);
  });

  it('snapshots every breaker it has handed out', () => {
    const registry = new CircuitRegistry({ failureThreshold: 1 });
    registry.get('ai').recordFailure(TRANSIENT);
    registry.get('engine');
    const byName = Object.fromEntries(registry.snapshots().map((s) => [s.name, s.state]));
    expect(byName).toEqual({ ai: 'open', engine: 'closed' });
  });

  it('resetAll closes everything', () => {
    const registry = new CircuitRegistry({ failureThreshold: 1 });
    registry.get('ai').recordFailure(TRANSIENT);
    registry.resetAll();
    expect(registry.get('ai').snapshot().state).toBe('closed');
  });
});
