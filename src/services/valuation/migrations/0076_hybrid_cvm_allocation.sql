-- Hybrid + CVM allocation methods (engine-wrapper app/engine/hybrid.py,
-- current_value.py). Widens valuation_params.allocation_method from
-- {opm, pwerm} to also allow:
--   * 'hybrid' — a configurable OPM+PWERM blend (near-term discrete exits
--     weighted with a far-term continuation OPM); weights live in
--     engine_inputs.hybrid.
--   * 'cvm'    — Current Value Method: the σ→0 deterministic waterfall applied
--     at the current equity value, for early-stage / pre-revenue / distressed
--     companies.
ALTER TABLE valuation_params
  DROP CONSTRAINT valuation_params_allocation_method_check;

ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_allocation_method_check
    CHECK (allocation_method IN ('opm', 'pwerm', 'hybrid', 'cvm'));
