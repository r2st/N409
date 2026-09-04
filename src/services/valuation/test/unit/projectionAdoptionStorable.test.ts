import { describe, expect, it } from 'vitest';
import { unstorableAdoption } from '../../src/routes/projections.js';
import { EngineInputsBody } from '../../src/routes/engineInputs.js';
import { MAX_QUANTITY } from '../../src/domain/finite.js';

/**
 * Adoption writes through `applyEngineInputsWithin` — the repo call — so
 * `EngineInputsBody`, which owns every other write of that document, never saw
 * what a projection put into it (R410, methodology M19).
 *
 * `terminal_metric` was closed one field at a time when a loss-making forecast
 * was found writing a metric the model form refuses. The other two written
 * fields have the same gap and the two schemas disagree about both: `revenues`
 * is non-negative in `EngineInputsBody` and signed in the projection route's
 * `Line`, and `free_cash_flows` is bounded at `MAX_QUANTITY` there while growth
 * mode compounds a rate that runs to 20 off a base that runs to 1e15.
 *
 * The run returns 200 either way. What breaks is the *next* save of the
 * financial model: `FinancialModelPanel` loads the whole income section into
 * its form and posts the whole thing back, so `PATCH /engine-inputs` answers
 * 422 on an array the analyst never touched, from a form with no way to correct
 * it.
 */
describe('unstorableAdoption', () => {
  const ok = {
    free_cash_flows: [1_000_000, 1_200_000],
    revenues: [10_000_000, 12_000_000],
    terminal_metric: 3_000_000,
    terminal_metric_basis: 'ebitda',
  };

  it('passes an ordinary run', () => {
    expect(unstorableAdoption(ok)).toBeNull();
  });

  it('refuses a driver run whose revenue line goes negative', () => {
    // `Line` in ProjectionRunBody is signed — deliberately, because `cogs`,
    // `capex` and `nwc` share the type and a negative capex is a disposal. The
    // revenue line shares it too, and `EngineInputsBody.revenues` is `nonNeg`.
    const refusal = unstorableAdoption({ ...ok, revenues: [10_000_000, -12_000_000] });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('income.revenues');
  });

  it('refuses a compounded forecast past the magnitude a double can add exactly', () => {
    // A base of 1e9 at a mistyped growth of 2 — 200% a year, for the 2% that
    // was meant — is 2e23 by year 30. `_finite` in projection.py passes it,
    // because it is finite.
    const refusal = unstorableAdoption({ ...ok, free_cash_flows: [1_000_000, MAX_QUANTITY * 10] });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('income.free_cash_flows');
  });

  it('names the field, so the refusal says which figure to look at', () => {
    expect(unstorableAdoption({ ...ok, revenues: [-1] })).toMatch(/^income\.revenues\b/);
  });

  it('still refuses the terminal metric the route already guarded', () => {
    // Belt and braces: the handler clears a non-positive metric before this
    // runs, so this asserts the schema agrees rather than a second policy.
    expect(unstorableAdoption({ ...ok, terminal_metric: -1 })).toContain('income.terminal_metric');
  });

  it('refuses exactly what the model form would refuse, and nothing else', () => {
    // The point of the check is that these two answers cannot drift apart.
    for (const income of [
      { ...ok, revenues: [-1] },
      { ...ok, free_cash_flows: [MAX_QUANTITY * 10] },
      { ...ok, free_cash_flows: Array.from({ length: 101 }, () => 1) },
      ok,
    ]) {
      const viaForm = EngineInputsBody.safeParse({ income }).success;
      expect(unstorableAdoption(income) === null).toBe(viaForm);
    }
  });
});
