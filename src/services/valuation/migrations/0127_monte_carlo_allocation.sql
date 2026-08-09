-- The simulated allocation (engine/monte_carlo.py). Widens
-- valuation_params.allocation_method from four methods to five.
--
-- Monte Carlo is not a fifth way to price the same thing. The closed-form OPM
-- is exact where the payoff is piecewise linear in terminal equity value and
-- that value is a single lognormal, and simulating under those conditions is
-- strictly worse — the same answer plus sampling noise. What it adds is the
-- case where the exit is *not* one lognormal: a company with a credible IPO at
-- five years and a credible trade sale at two has two exit distributions with
-- different horizons and different volatilities, and the common stock's value
-- depends on the spread within each, not only on its mean.
--
-- That sits between the two methods already here. PWERM answers the same
-- question with point estimates per scenario — one exit value, no uncertainty
-- around it — and `hybrid` blends a PWERM point estimate with an OPM by a
-- weight somebody chose. This carries discrete scenarios *and* the lognormal
-- inside each, and reduces exactly to the OPM at one scenario, which is how the
-- engine tests check it.
--
-- The constraint is rewritten rather than extended because Postgres has no
-- "add a value to a CHECK IN list"; 0076 did the same when hybrid and cvm
-- arrived. No row changes: every existing valuation keeps the method it has.
ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_allocation_method_check;

ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_allocation_method_check
    CHECK (allocation_method IN ('opm', 'pwerm', 'hybrid', 'cvm', 'monte_carlo'));

COMMENT ON COLUMN valuation_params.allocation_method IS
  'How concluded equity value is split across share classes: opm (Black-Scholes breakpoints), pwerm (discrete exit scenarios), hybrid (a weighted blend of the two), cvm (deterministic waterfall), monte_carlo (simulated, with per-scenario horizon and volatility). Monte Carlo requires the cap table and reports its own standard error and seed.';
