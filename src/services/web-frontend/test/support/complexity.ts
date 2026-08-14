/**
 * Guarding an algorithm's exponent, not the speed of the machine it runs on.
 *
 * The client mirror of the report sanitizer was quadratic on input that never
 * closes a tag, and is now guarded by a test. The obvious guard — run the
 * pathological input, assert a wall-clock ceiling — is the one that flakes,
 * because the number it compares against is a property of the CI box rather
 * than of the code. The margin has to absorb a cold JIT, a GC pause over a
 * multi-megabyte string, coverage instrumentation, and however many other
 * vitest workers hold the CPU. `report.test.ts` carried such a guard budgeted
 * at 3s against a 2.1s idle cost and failed at 3.4s under load: a 1.4x margin
 * described in its own comment as "loose so a slow CI box does not flake it".
 *
 * The property those tests exist to defend is not "under three seconds". It is
 * "four times the input costs about four times as much, not sixteen times".
 * That ratio is dimensionless: a machine half as fast, or twice as loaded,
 * inflates both measurements and cancels out of the quotient. Asserting on it
 * takes the machine out of the assertion altogether.
 *
 * What this deliberately does not catch is a regression that stays linear and
 * gets uniformly slower — that is a performance change, not a complexity one,
 * and a ratio cannot see it. These guards were written for the exponent, which
 * is the failure that took the service from milliseconds to tens of seconds.
 */
import { expect } from 'vitest';

/**
 * The cheapest of `runs` attempts at `work`, in milliseconds.
 *
 * The minimum rather than the mean or the median, because every source of
 * noise on a test machine is one-sided: a scheduler slice lost to another
 * worker, a GC pause, a core that clocked down under thermal load. None of
 * them can make the work finish sooner than it really is. The fastest observed
 * run is therefore the closest estimate of the true cost available here, and
 * the only summary that does not drift upward as the box gets busier.
 */
export function fastestOf(work: () => unknown, runs = 5): number {
  let best = Infinity;
  for (let attempt = 0; attempt < runs; attempt += 1) {
    const started = performance.now();
    work();
    const elapsed = performance.now() - started;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

export interface ScalingProbe<T> {
  /** Builds the input of a given size. Called outside every timed region. */
  readonly input: (size: number) => T;
  /** The scan under test. */
  readonly run: (input: T) => unknown;
  /**
   * Size of the smaller input, in whatever unit `input` counts.
   *
   * Small is a feature, and the measurements above are the reason. What breaks
   * a timing test under load is a *long* timed region: a run of 30ms is exposed
   * to far more of the scheduler than one of 4ms, so on a busy box the larger
   * input is interrupted disproportionately often and the quotient drifts up.
   * Keeping both runs inside a scheduler slice is what makes the minimum of
   * several attempts a clean sample rather than a slightly-less-dirty one.
   *
   * Sizing down costs nothing, because the exponent is visible at any scale —
   * and it buys a guard that fails in seconds rather than minutes when it is
   * right to fail, which is what keeps people running it.
   */
  readonly size: number;
  /** How much bigger the second input is. Four keeps linear and quadratic far apart. */
  readonly growth?: number;
  readonly runs?: number;
  readonly attempts?: number;
}

/**
 * One estimate of how much more the larger input costs than the smaller one.
 *
 * Both inputs are built before anything is timed, and both are run once before
 * anything is measured. Warming only the larger one is not enough, and the
 * failure is the dangerous direction: the small input is measured first, so on
 * a cold function it absorbs the tier-up that the large input then benefits
 * from, the denominator comes out too big, and the quotient too small. Pointed
 * at deliberately quadratic code that way, this helper returned a ratio under
 * the limit and passed it.
 */
function ratioOnce<T>(probe: Required<Omit<ScalingProbe<T>, 'attempts'>>): {
  ratio: number;
  smallCost: number;
  largeCost: number;
} {
  const { input, run, size, growth, runs } = probe;
  const small = input(size);
  const large = input(size * growth);

  // Warm up both: the first pass over each pays for JIT and for growing the heap.
  run(small);
  run(large);

  const smallCost = fastestOf(() => run(small), runs);
  const largeCost = fastestOf(() => run(large), runs);

  // A floor on the denominator: below a few tens of microseconds the quotient
  // reports timer granularity rather than the cost of the work.
  return { ratio: largeCost / Math.max(smallCost, 0.05), smallCost, largeCost };
}

/**
 * Assert that `run` costs no more than `growth ** 1.5` times as much when its
 * input grows by `growth`.
 *
 * With the default growth of four, linear predicts 4x and quadratic predicts
 * 16x; the threshold sits at 8, a clean factor of two from each.
 *
 * The measurement is retried because load does not disturb the two halves of
 * the quotient equally. A run that takes 30ms is exposed to far more of the
 * scheduler than one that takes 7ms, so a busy box inflates the numerator
 * more often than the denominator and pushes the ratio up: measured against a
 * genuinely linear sanitizer on a machine with twice as many spinning
 * processes as cores, a single probe returned 9.7x and would have failed here.
 *
 * Retrying fixes that for the same reason the minimum is taken within a probe:
 * the noise is one-sided. No amount of interference makes quadratic code look
 * linear, so a repeat can only rescue a false failure, never manufacture a
 * false pass. A healthy implementation settles on the first attempt and pays
 * nothing for the loop.
 *
 * Measured against the real sanitizer on a twelve-core machine carrying
 * twenty-four spinning processes — twice as many runnable threads as cores,
 * rather worse than CI under a full vitest fan-out — these defaults produced no
 * false failure in 32 probes, the worst linear ratio being 4.35x against the
 * limit of 8. The same probe pointed at the quadratic regexes these scans
 * replaced reported 13.6x and 21.7x, so the verdict survives in both
 * directions.
 */
export function expectSubQuadratic<T>(probe: ScalingProbe<T>): void {
  const { input, run, size, growth = 4, runs = 15, attempts = 3 } = probe;
  const limit = growth ** 1.5;

  let best = { ratio: Infinity, smallCost: 0, largeCost: 0 };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const measured = ratioOnce({ input, run, size, growth, runs });
    if (measured.ratio < best.ratio) best = measured;
    if (best.ratio < limit) break;
  }

  expect(
    best.ratio,
    `expected ${growth}x the input to cost under ${limit.toFixed(1)}x as much ` +
      `(linear is ${growth}x, quadratic is ${growth ** 2}x); ` +
      `${size} took ${best.smallCost.toFixed(2)}ms and ${size * growth} took ` +
      `${best.largeCost.toFixed(2)}ms, a ratio of ${best.ratio.toFixed(1)}x, ` +
      `the lowest of ${attempts} attempts`,
  ).toBeLessThan(limit);
}
