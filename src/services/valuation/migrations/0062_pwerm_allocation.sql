-- PWERM allocation method (engine-wrapper app/engine/pwerm.py). A valuation
-- allocates equity value to common either by the OPM (the default, a
-- Black-Scholes call over the preference stack) or by PWERM (probability-
-- weighted discrete exit scenarios). The scenarios themselves live in
-- valuation_params.engine_inputs.pwerm.scenarios; this column selects which
-- allocation method the engine runs.
ALTER TABLE valuation_params
  ADD COLUMN allocation_method text NOT NULL DEFAULT 'opm'
    CHECK (allocation_method IN ('opm', 'pwerm'));
