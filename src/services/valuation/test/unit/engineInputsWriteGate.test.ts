import { describe, expect, it } from 'vitest';
import { unstorableEngineInputs } from '../../src/routes/engineInputs.js';
import { MAX_QUANTITY } from '../../src/domain/finite.js';
import { numericCeiling, ROLLFORWARD_EQUITY_VALUE } from '../../src/domain/numericColumn.js';

/**
 * The writers of `engine_inputs` that never pass a body through
 * `EngineInputsBody` (R410, methodology M19).
 *
 * `applyEngineInputs` is the repo call, and three routes reach it without the
 * route schema: the projection adoption, the roll-forward adoption, and the AI
 * apply (which has its own narrower gate). `routes/projections.ts` has named
 * the consequence since R404 — "a value into `engine_inputs` by the one path
 * that did not check it — and the 422 then arrived on whoever next pressed
 * Calculate, naming a field they had not touched" — and it was closed one field
 * at a time.
 *
 * The reason it keeps arriving is that the two bounds on one figure are set by
 * different considerations and drift apart without either author being wrong:
 * a column's precision on one side, and on the other the magnitude past which a
 * double stops adding exactly.
 */
describe('unstorableEngineInputs', () => {
  it('passes what the model form would accept', () => {
    expect(unstorableEngineInputs({ last_round_post_money: 42_000_000 })).toBeNull();
    expect(unstorableEngineInputs({ income: { free_cash_flows: [1, 2, 3] } })).toBeNull();
  });

  it('names the field and the reason, not just that something was wrong', () => {
    const refusal = unstorableEngineInputs({ last_round_post_money: -1 });
    expect(refusal).toMatch(/^last_round_post_money:/);
  });

  it('checks only the fields it is given, so a merged section is not re-judged', () => {
    // The section an adoption merges into is the analyst's. Passing the whole
    // document would refuse a run over a figure somebody else left there.
    expect(unstorableEngineInputs({ last_round_post_money: 1 })).toBeNull();
  });

  /**
   * The roll-forward anchor: storable in its own column, refused by the form.
   *
   * `rolled_equity_value` is `numeric(20, 2)` and `requireStorableFigure` holds
   * it below 1e18. `last_round_post_money` is `boundedNonNegative()` and stops
   * at `MAX_QUANTITY`. Everything between the two is a value the run stores and
   * the adoption used to write.
   */
  describe('the roll-forward anchor', () => {
    it('leaves a gap between the run column and the model form', () => {
      // Not an assertion about the fix — an assertion that the gap this closes
      // is real, so a later change to either bound fails here.
      expect(numericCeiling(ROLLFORWARD_EQUITY_VALUE)).toBeGreaterThan(MAX_QUANTITY);
    });

    it('refuses an anchor a nine-year gap at a mistyped rate produces', () => {
      // $10M x 11^9 = 2.3e16 — inside `numeric(20, 2)`, past `MAX_QUANTITY`.
      const rolled = 10_000_000 * 11 ** 9;
      expect(rolled).toBeLessThan(numericCeiling(ROLLFORWARD_EQUITY_VALUE));
      expect(rolled).toBeGreaterThan(MAX_QUANTITY);
      expect(unstorableEngineInputs({ last_round_post_money: rolled })).toMatch(
        /^last_round_post_money:/,
      );
    });

    it('still adopts an anchor of an ordinary size', () => {
      expect(unstorableEngineInputs({ last_round_post_money: 250_000_000 })).toBeNull();
      expect(unstorableEngineInputs({ last_round_post_money: MAX_QUANTITY })).toBeNull();
    });
  });
});
