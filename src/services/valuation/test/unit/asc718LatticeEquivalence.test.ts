import { describe, expect, it } from 'vitest';
import { binomialLattice } from '../../src/domain/asc718Public.js';

/**
 * The lattice's arithmetic, unchanged by R409's power table (methodology M8).
 *
 * `binomialLattice` used to evaluate `s0 * u ** j * d ** (i - j)` once per node
 * of a triangle with (N+1)(N+2)/2 of them, and carry the exercise decision in an
 * array of `boolean[]` per step. R409 replaced the two `Math.pow` calls with two
 * loop-invariant tables and the ragged array with one flat `Uint8Array`, on the
 * argument that neither changes a number: `u ** j` is a deterministic double, so
 * a table of it holds exactly what the call returned.
 *
 * That argument is only worth as much as a test of it, because the failure it
 * guards against is silent — a fair value that moves in the fourth decimal is
 * still a plausible fair value, and this one is disclosed. So the reference
 * below is the pre-R409 body, verbatim apart from the two shapes that changed,
 * and the sweep asserts exact equality rather than closeness.
 */
function referenceLattice(args: {
  underlying: number;
  strike: number;
  contractualTermYears: number;
  vestingYears: number;
  volatility: number;
  riskFreeRate: number;
  dividendYield?: number;
  exerciseMultiple?: number;
  steps?: number;
  postVestExitRate?: number;
}): { fairValue: number; expectedTermYears: number } {
  const round4 = (n: number) => Math.round(n * 10000) / 10000;
  const s0 = args.underlying;
  const k = args.strike;
  const T = args.contractualTermYears;
  const sigma = args.volatility;
  const r = args.riskFreeRate;
  const q = args.dividendYield ?? 0;
  const m = args.exerciseMultiple ?? 2.0;
  const N = Math.max(10, Math.min(Math.floor(args.steps ?? 200), 2000));
  if (s0 <= 0) return { fairValue: 0, expectedTermYears: 0 };
  if (T <= 0 || sigma <= 0) {
    return { fairValue: Math.max(0, s0 - k), expectedTermYears: round4(Math.max(0, T)) };
  }
  const dt = T / N;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const disc = Math.exp(-r * dt);
  const p = (Math.exp((r - q) * dt) - d) / (u - d);
  const pClamped = Math.min(Math.max(p, 0), 1);
  const vestStep = Math.min(N, Math.ceil((args.vestingYears / T) * N));
  const exitPerStep = Math.min(Math.max(args.postVestExitRate ?? 0, 0), 1) * dt;

  let value = new Array<number>(N + 1).fill(0);
  // The expression R409 replaced with a table lookup.
  const price = (i: number, j: number) => s0 * u ** j * d ** (i - j);
  for (let j = 0; j <= N; j++) value[j] = Math.max(0, price(N, j) - k);
  const exercisesAt: boolean[][] = [];
  for (let i = N - 1; i >= 0; i--) {
    const next = new Array<number>(i + 1).fill(0);
    const flags = new Array<boolean>(i + 1).fill(false);
    for (let j = 0; j <= i; j++) {
      const cont = disc * (pClamped * (value[j + 1] ?? 0) + (1 - pClamped) * (value[j] ?? 0));
      const s = price(i, j);
      const vested = i >= vestStep;
      if (vested && s >= m * k) {
        next[j] = s - k;
        flags[j] = true;
      } else {
        next[j] = cont;
        flags[j] = false;
      }
      if (vested && exitPerStep > 0 && i >= 1) {
        next[j] = (1 - exitPerStep) * (next[j] ?? 0) + exitPerStep * Math.max(0, s - k);
      }
    }
    exercisesAt[i] = flags;
    value = next;
  }
  const fairValue = value[0] ?? 0;

  let prob = [1];
  let expTerm = 0;
  let absorbed = 0;
  for (let i = 0; i < N; i++) {
    const nextProb = new Array<number>(i + 2).fill(0);
    const flags = exercisesAt[i] ?? [];
    for (let j = 0; j <= i; j++) {
      const mass = prob[j] ?? 0;
      if (mass <= 0) continue;
      if (flags[j]) {
        expTerm += mass * i * dt;
        absorbed += mass;
      } else {
        nextProb[j + 1] = (nextProb[j + 1] ?? 0) + mass * pClamped;
        nextProb[j] = (nextProb[j] ?? 0) + mass * (1 - pClamped);
      }
    }
    if (i + 1 >= vestStep && exitPerStep > 0) {
      for (let j = 0; j <= i + 1; j++) {
        const here = nextProb[j] ?? 0;
        if (here > 0) {
          const leave = here * exitPerStep;
          nextProb[j] = here - leave;
          expTerm += leave * (i + 1) * dt;
          absorbed += leave;
        }
      }
    }
    prob = nextProb;
  }
  for (let j = 0; j < prob.length; j++) {
    const mass = prob[j] ?? 0;
    if (mass > 0) {
      expTerm += mass * T;
      absorbed += mass;
    }
  }
  return {
    fairValue: round4(fairValue),
    expectedTermYears: round4(absorbed > 0 ? expTerm / absorbed : T),
  };
}

describe('binomialLattice — the power table is the same arithmetic (R409, M8)', () => {
  it('agrees with the pre-optimisation body exactly across a parameter sweep', () => {
    let cases = 0;
    for (const underlying of [30, 12.5, 0.9])
      for (const strike of [30, 45, 1])
        for (const volatility of [0.45, 0.2, 1.1])
          for (const vestingYears of [4, 0.5])
            for (const postVestExitRate of [0, 0.15, 1])
              for (const steps of [undefined, 10, 37, 300]) {
                const args = {
                  underlying,
                  strike,
                  contractualTermYears: 10,
                  vestingYears,
                  volatility,
                  riskFreeRate: 0.04,
                  dividendYield: 0.01,
                  exerciseMultiple: 2.5,
                  postVestExitRate,
                  steps,
                };
                expect(binomialLattice(args), JSON.stringify(args)).toEqual(referenceLattice(args));
                cases++;
              }
    expect(cases).toBe(648);
  });

  it('keeps the degenerate arms the table never reaches', () => {
    // `s0 <= 0` and `sigma <= 0` return before the tables are built; both are
    // reachable from the route, which accepts a substituted volatility.
    for (const args of [
      { underlying: 0, strike: 10, contractualTermYears: 10, vestingYears: 4, volatility: 0.4, riskFreeRate: 0.04 },
      { underlying: 30, strike: 10, contractualTermYears: 10, vestingYears: 4, volatility: 0, riskFreeRate: 0.04 },
      { underlying: 30, strike: 10, contractualTermYears: 0, vestingYears: 0, volatility: 0.4, riskFreeRate: 0.04 },
    ]) {
      expect(binomialLattice(args)).toEqual(referenceLattice(args));
    }
  });

  it('indexes the exercise triangle per node, not per step', () => {
    // The flat `Uint8Array` replaced one array per step. A wrong row offset
    // reads another step's decision, which moves only the expected term — the
    // value is built by the backward pass and would not notice. A barrier the
    // tree crosses early is where the two disagree most.
    const args = {
      underlying: 100,
      strike: 10,
      contractualTermYears: 10,
      vestingYears: 1,
      volatility: 0.6,
      riskFreeRate: 0.04,
      exerciseMultiple: 1.5,
      steps: 64,
    };
    const got = binomialLattice(args);
    expect(got).toEqual(referenceLattice(args));
    // The barrier is crossed within a step or two of the vest, so the term
    // sits just above it rather than at the ten-year contractual end — which
    // is what makes this case sensitive to reading the wrong step's flags.
    expect(got.expectedTermYears).toBeLessThan(1.5);
  });
});
