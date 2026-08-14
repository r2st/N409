import { describe, expect, it } from 'vitest';
import { expectSubQuadratic, fastestOf } from '../support/complexity.js';

/**
 * The guard that guards the guards.
 *
 * `expectSubQuadratic` replaced a family of wall-clock ceilings, and a
 * complexity guard that cannot fail is worse than the flaky one it replaced:
 * the flaky test at least told the truth twice a day. So the helper is pointed
 * at code whose exponent is known by construction — a linear scan and a
 * deliberately quadratic one — and is required to reach the right verdict on
 * each.
 *
 * The quadratic subject is a nested loop rather than a regex, because it has to
 * stay quadratic no matter what the engine learns to optimise.
 */

/** Genuinely linear: one pass, work proportional to length. */
function linearScan(s: string): number {
  let seen = 0;
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 60) seen += 1;
  return seen;
}

/** Genuinely quadratic: for each character, another pass over the tail. */
function quadraticScan(s: string): number {
  let seen = 0;
  for (let i = 0; i < s.length; i += 1) {
    for (let j = i; j < s.length; j += 1) if (s.charCodeAt(j) === 62) seen += 1;
  }
  return seen;
}

const text = (n: number) => '<p'.repeat(n / 2);

describe('fastestOf', () => {
  it('reports the cheapest run, not the average or the last', () => {
    // One deliberately slow pass among cheap ones must not move the answer:
    // this is the whole reason the minimum is the summary being used.
    let call = 0;
    const cost = fastestOf(() => {
      call += 1;
      if (call === 2) {
        const until = performance.now() + 25;
        while (performance.now() < until) {
          /* burn a slice, as a descheduled run would */
        }
      }
    }, 5);
    expect(call).toBe(5);
    expect(cost).toBeLessThan(20);
  });

  it('runs the work exactly as many times as asked', () => {
    let calls = 0;
    fastestOf(() => {
      calls += 1;
    }, 7);
    expect(calls).toBe(7);
  });
});

describe('expectSubQuadratic', () => {
  it('passes code that is linear', () => {
    expectSubQuadratic({ input: text, run: linearScan, size: 25_000 });
  });

  it('fails code that is quadratic', () => {
    // Small on purpose: at 2,000 the quadratic subject is already unmistakable
    // and the failing assertion still returns in well under a second.
    //
    // Keep this the first case in the file to touch `quadraticScan`. Running it
    // cold is the point: an earlier draft of the helper warmed up on the larger
    // input only, so the small measurement absorbed the JIT tier-up, the ratio
    // came out under the limit, and this exact assertion passed quadratic code.
    // Move it below another user of `quadraticScan` and it stops testing that.
    expect(() => expectSubQuadratic({ input: text, run: quadraticScan, size: 2_000, runs: 3 })).toThrow();
  });

  it('names both measurements when it fails, so the number can be judged', () => {
    // A bare "expected 19.2 to be less than 8" is not enough to tell a genuine
    // regression from a machine having a bad moment; the costs have to be in
    // the message.
    let message = '';
    try {
      expectSubQuadratic({ input: text, run: quadraticScan, size: 2_000, runs: 3 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/took [\d.]+ms/);
    expect(message).toMatch(/ratio of/);
    expect(message).toMatch(/lowest of 3 attempts/);
  });

  it('gives a quadratic subject every retry before failing it', () => {
    // The retry loop must not short-circuit on a bad ratio — it breaks early
    // only when a probe comes in *under* the limit. Counting the builds proves
    // all three attempts ran.
    let built = 0;
    expect(() =>
      expectSubQuadratic({
        input: (n) => {
          built += 1;
          return text(n);
        },
        run: quadraticScan,
        size: 2_000,
        runs: 3,
        attempts: 3,
      }),
    ).toThrow();
    expect(built).toBe(6); // two inputs per attempt, three attempts
  });

  it('stops after the first attempt when the code is healthy', () => {
    let built = 0;
    expectSubQuadratic({
      input: (n) => {
        built += 1;
        return text(n);
      },
      run: linearScan,
      size: 25_000,
    });
    expect(built).toBe(2); // one attempt was enough
  });
});
