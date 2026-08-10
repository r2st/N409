import { describe, expect, it } from 'vitest';
import { ParamsPatchBody, validateWaccBuildUp } from '../../src/routes/params.js';

/**
 * The discount-rate build-up accepted on PATCH /params (migration 0135).
 *
 * The split of responsibility mirrors the DLOM schema's: this checks *shape*
 * and *plausible magnitude*, and the engine's `_WACC_KEYS` pre-flight is the
 * second gate on membership. The keys are the interesting half — they are
 * spread onto `compute_wacc(**wacc_in)` as keyword arguments, so a key this
 * schema let through that the engine does not take is a TypeError at the end of
 * a calculation rather than a 422 on the form.
 *
 * The magnitude bands are the cheap half of the fractions defence: every
 * premium and rate here is a fraction, and 5 for 5% is the mistake that reaches
 * the engine's overflow guard.
 */

const ok = (patch: Record<string, unknown>) => ParamsPatchBody.safeParse(patch);

/**
 * The engine's `_WACC_KEYS`, from `engine/compute.py`, each against a value the
 * engine would accept for it.
 */
const ENGINE_WACC_KEYS: Record<string, unknown> = {
  comparable_betas: [{ ticker: 'AAA', beta: 1.2 }],
  company_specific_premium: 0.03,
  cost_of_debt: 0.08,
  debt_weight: 0.25,
  equity_risk_premium: 0.055,
  forecast_horizon_years: 5,
  market_cap: 40_000_000,
  risk_free_rate_override: 0.042,
  size_premium_override: 0.0537,
  target_debt_to_equity: 0.3,
  tax_rate: 0.21,
  treasury_curve: { '5': 0.042, '10': 0.045 },
  unlevered_beta_input: 1.1,
};

/** A build-up that passes, to vary one key at a time from. */
const GOOD = {
  comparable_betas: [
    { ticker: 'AAA', name: 'Alpha Corp', beta: 1.2, debt_to_equity: 0.25, tax_rate: 0.21 },
    { ticker: 'BBB', beta: 0.9 },
  ],
  target_debt_to_equity: 0.3,
  market_cap: 40_000_000,
  tax_rate: 0.21,
  equity_risk_premium: 0.055,
  forecast_horizon_years: 5,
  company_specific_premium: 0.03,
  cost_of_debt: 0.08,
};

describe('wacc_inputs shape', () => {
  it('accepts a build-up off a guideline beta set', () => {
    expect(ok({ wacc_inputs: GOOD }).success).toBe(true);
  });

  it('accepts a build-up off a published unlevered beta instead', () => {
    expect(ok({ wacc_inputs: { unlevered_beta_input: 1.1, target_debt_to_equity: 0.2 } }).success).toBe(true);
  });

  it('accepts null (no build-up on the engagement)', () => {
    expect(ok({ wacc_inputs: null }).success).toBe(true);
  });

  it('takes every key the engine takes, and only those', () => {
    /*
     * The contract with `compute_wacc(**wacc_in)`. A key accepted here that the
     * engine does not take is a TypeError raised at the end of a calculation;
     * a key the engine takes and this refuses is a knob no analyst can reach.
     */
    // Every engine key on its own, so a key this schema is missing shows up as
    // that key rather than as one failure over a big object.
    for (const [key, value] of Object.entries(ENGINE_WACC_KEYS)) {
      const parsed = ok({ wacc_inputs: { unlevered_beta_input: 1.1, [key]: value } });
      expect(parsed.success, `wacc_inputs.${key} should be accepted`).toBe(true);
    }
    // And every key together, which is also the whole set the panel plus the
    // API can produce.
    expect(ok({ wacc_inputs: ENGINE_WACC_KEYS }).success).toBe(true);

    expect(ok({ wacc_inputs: { ...GOOD, illiquidity_premium: 0.02 } }).success).toBe(false);
    expect(ok({ wacc_inputs: { ...GOOD, beta: 1.2 } }).success).toBe(false);
  });

  it('reads a percentage typed where a fraction belongs as a mistake', () => {
    /*
     * 5.5 for a 5.5% equity risk premium is the error this band exists for. It
     * is not caught by anything downstream that would name the field: the
     * engine's overflow guard fires several steps later, on a cost of equity
     * nobody typed.
     */
    expect(ok({ wacc_inputs: { ...GOOD, equity_risk_premium: 5.5 } }).success).toBe(false);
    expect(ok({ wacc_inputs: { ...GOOD, tax_rate: 21 } }).success).toBe(false);
    expect(ok({ wacc_inputs: { ...GOOD, cost_of_debt: 8 } }).success).toBe(false);
    expect(ok({ wacc_inputs: { ...GOOD, risk_free_rate_override: 4.2 } }).success).toBe(false);
    expect(ok({ wacc_inputs: { ...GOOD, treasury_curve: { '5': 4.2 } } }).success).toBe(false);
  });

  it('allows a company-specific premium to be negative and a beta to be low', () => {
    // Both are legitimate: a subject less risky than the guideline set carries
    // a negative adjustment, and a defensive peer a beta below 1.
    expect(ok({ wacc_inputs: { ...GOOD, company_specific_premium: -0.01 } }).success).toBe(true);
    expect(ok({ wacc_inputs: { unlevered_beta_input: 0.35 } }).success).toBe(true);
  });

  it('refuses a beta row with no beta in it', () => {
    expect(ok({ wacc_inputs: { comparable_betas: [{ ticker: 'AAA' }] } }).success).toBe(false);
  });

  it('refuses an empty beta set rather than storing a set with no members', () => {
    expect(ok({ wacc_inputs: { comparable_betas: [] } }).success).toBe(false);
  });

  it('refuses a negative forecast horizon and a negative gearing', () => {
    expect(ok({ wacc_inputs: { ...GOOD, forecast_horizon_years: 0 } }).success).toBe(false);
    expect(ok({ wacc_inputs: { ...GOOD, target_debt_to_equity: -0.1 } }).success).toBe(false);
  });

  it('refuses an unknown key inside a beta row', () => {
    expect(ok({ wacc_inputs: { comparable_betas: [{ beta: 1.1, sector: 'software' }] } }).success).toBe(
      false,
    );
  });
});

describe('validateWaccBuildUp', () => {
  const EMPTY = { wacc_inputs: null, auto_wacc: false };

  it('passes a build-up recorded but not switched on', () => {
    expect(validateWaccBuildUp(EMPTY, { wacc_inputs: GOOD }).ok).toBe(true);
  });

  it('passes a build-up switched on in the same patch that records it', () => {
    expect(validateWaccBuildUp(EMPTY, { wacc_inputs: GOOD, auto_wacc: true }).ok).toBe(true);
  });

  it('passes when the patch touches neither', () => {
    expect(validateWaccBuildUp(EMPTY, {}).ok).toBe(true);
  });

  it('refuses the switch with nothing to run', () => {
    /*
     * The engine's `auto_wacc` branch skips a missing or empty `inputs.wacc` in
     * silence. Without this the switch would sit on, the discount rate would
     * stay whatever was typed, and Appendix I would still not render — a
     * feature that reads as configured and does nothing.
     */
    const result = validateWaccBuildUp(EMPTY, { auto_wacc: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain('before switching it on');
  });

  it('refuses the switch when the patch clears the build-up under it', () => {
    const current = { wacc_inputs: GOOD, auto_wacc: true };
    expect(validateWaccBuildUp(current, { wacc_inputs: null }).ok).toBe(false);
  });

  it('sees a build-up already on the row when the patch only flips the switch', () => {
    expect(validateWaccBuildUp({ wacc_inputs: GOOD, auto_wacc: false }, { auto_wacc: true }).ok).toBe(true);
  });

  it('refuses a build-up with no beta on either route into it', () => {
    /*
     * The engine raises "provide comparable_betas or unlevered_beta_input".
     * Catching it here names the field while the analyst is still on the form,
     * rather than at the end of a calculation.
     */
    const result = validateWaccBuildUp(EMPTY, {
      wacc_inputs: { target_debt_to_equity: 0.3, equity_risk_premium: 0.055 },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain('beta');
  });

  it('checks the beta rule on a recorded build-up even when it is switched off', () => {
    // A build-up stored now is one somebody will switch on later, possibly
    // without editing it. Storing one the engine cannot run defers the failure
    // to whoever flips the switch.
    expect(
      validateWaccBuildUp(EMPTY, { wacc_inputs: { equity_risk_premium: 0.055 }, auto_wacc: false }).ok,
    ).toBe(false);
  });
});
