-- Narrative prompt library, part two: the five deliverables that were still
-- being drafted with the 409A's guidance.
--
-- 0114 seeded the base library and overrode it for five kinds — qsbs, ppa,
-- 820, gifts, ifrs2. The other ten fall back to the base library, and for most
-- of them that is right: an FMV opinion and a 409A really do want the same
-- eight sections. For these five it is not, and the reason is visible in
-- `NARRATIVE_SECTION_MAP_BY_KIND` (domain/narrativeApply.ts).
--
-- That map routes a drafted section into the chapter its skeleton actually
-- has, and on these kinds it routes several of them somewhere with a different
-- name and a different subject:
--
--   * `debt.company_overview` → the Credit Assessment chapter. The agent was
--     asked for "what the company does, its stage and traction, and the
--     industry it competes in" and the answer was filed under a heading that
--     wants a rating, a position in the capital structure, and the covenants
--     that change expected recovery. The prose landed in the report; it just
--     was not an assessment of anybody's credit.
--   * `debt.income_approach` → Discount Rate. `718.valuation_methodology` →
--     Valuation Model & Assumptions. `fund.valuation_methodology` →
--     Valuation Techniques, and `fund.conclusion` → Net Asset Value.
--     `goodwill.valuation_methodology` → Quantitative Tests.
--     `ip.valuation_methodology` → Valuation Methods.
--
-- Routing was the right fix for a chapter that exists under another name. It
-- cannot fix the guidance, because the guidance is the 409A's: a fund's
-- techniques chapter was drafted from "which approaches were used and how they
-- were weighted", which is not how a portfolio is measured, and an impairment
-- test's quantitative chapter from the same sentence, which is not how a
-- reporting unit is tested.
--
-- And the chapters these skeletons have that the 409A does not — the awards
-- measured, the expense attribution, the unit of account, the instrument's
-- terms, the reporting units, the subject asset — had no library row at all,
-- so nothing was ever drafted for them and they shipped as the skeleton wrote
-- them.
--
-- Two kinds of row below, and both are keyed to the chapter they are written
-- for so the map passes them through unchanged:
--
--   * an override of a base section, with this deliverable's subject in it.
--   * a new section for a chapter only this deliverable has.
--
-- Plus the suppressions. A base section the map already routes to NULL is
-- drafted on every run and discarded on every run; disabling it here stops the
-- agent being asked for prose nobody will read, and — more to the point —
-- stops it being asked to discuss a marketability discount on an award, a
-- reporting unit or a bond, which is the invitation to invent one.

-- ── ASC 718: an award is measured, not a company ────────────────────────────
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000035', '718', 'measurement_objective', 'Measurement Objective',
   'why grant-date fair value is the measurement ASC 718 requires, what fixes the grant date (the mutual understanding of the award''s key terms), and the requisite service period the resulting cost is recognized over',
   'why grant-date fair value is the measurement ASC 718 requires, what fixes the grant date (the mutual understanding of the award''s key terms), and the requisite service period the resulting cost is recognized over', 15),
  ('01N409NARR0000000000000036', '718', 'awards', 'Awards Measured',
   'the awards this measurement covers: the instrument (options, RSUs, ESPP rights), grant dates, counts, exercise prices, vesting schedules, and any performance or market condition attached',
   'the awards this measurement covers: the instrument (options, RSUs, ESPP rights), grant dates, counts, exercise prices, vesting schedules, and any performance or market condition attached', 25),
  ('01N409NARR0000000000000037', '718', 'valuation_methodology', 'Valuation Model & Assumptions',
   'the model applied — Black-Scholes-Merton for a plain award, a lattice or Monte Carlo simulation where exercise behaviour or a market condition requires one — and the basis for each assumption: the expected term and how it was derived, the expected volatility and the period it is measured over, the risk-free rate matched to that term, and the dividend yield',
   'the model applied — Black-Scholes-Merton for a plain award, a lattice or Monte Carlo simulation where exercise behaviour or a market condition requires one — and the basis for each assumption: the expected term and how it was derived, the expected volatility and the period it is measured over, the risk-free rate matched to that term, and the dividend yield', 30),
  ('01N409NARR0000000000000038', '718', 'expense_recognition', 'Expense Recognition',
   'the attribution — straight-line or graded over the requisite service period — the forfeiture policy elected, when a performance condition is recognized (on probability), and that a market condition is never reversed for failing to be met: treating the two alike is what misstates the charge',
   'the attribution — straight-line or graded over the requisite service period — the forfeiture policy elected, when a performance condition is recognized (on probability), and that a market condition is never reversed for failing to be met: treating the two alike is what misstates the charge', 65),
  ('01N409NARR0000000000000039', '718', 'conclusion', 'Fair Value of the Underlying Share',
   'the fair value of the underlying share at the measurement date and where it comes from — the concurrent 409A conclusion for a private issuer, the observed market price for a public one, cited with its own valuation date — together with the total grant-date fair value measured across the awards',
   'the fair value of the underlying share at the measurement date and where it comes from — the concurrent 409A conclusion for a private issuer, the observed market price for a public one, cited with its own valuation date — together with the total grant-date fair value measured across the awards', 80)
ON CONFLICT (kind, section_key) DO NOTHING;

INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000040', '718', 'company_overview', 'Company Overview and Industry Analysis',
   'what the company does, its stage and traction, and the industry it competes in',
   'what the company does, its stage and traction, and the industry it competes in', 20, false),
  ('01N409NARR0000000000000041', '718', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 40, false),
  ('01N409NARR0000000000000042', '718', 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 50, false),
  ('01N409NARR0000000000000043', '718', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false),
  ('01N409NARR0000000000000044', '718', 'dlom_analysis', 'Discount for Lack of Marketability',
   'the DLOM method chosen, the factors considered, and the resulting discount',
   'the DLOM method chosen, the factors considered, and the resulting discount', 70, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ── Fund NAV (ASC 820): a portfolio measured holding by holding ─────────────
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000045', 'fund', 'standard_of_value', 'Standard of Value',
   'fair value as ASC 820 defines it — the exit price received to sell in an orderly transaction between market participants in the principal or most advantageous market — and that this is not cost, not an entry price, and not the value of the holding to this fund in particular',
   'fair value as ASC 820 defines it — the exit price received to sell in an orderly transaction between market participants in the principal or most advantageous market — and that this is not cost, not an entry price, and not the value of the holding to this fund in particular', 15),
  ('01N409NARR0000000000000046', 'fund', 'unit_of_account', 'Unit of Account',
   'that each holding is measured as the security actually owned — a specific class with its own liquidation preference and conversion rights — rather than as a pro-rata share of the portfolio company''s equity; and where the fund holds more than one class in the same company, whether those classes are measured together or separately and why',
   'that each holding is measured as the security actually owned — a specific class with its own liquidation preference and conversion rights — rather than as a pro-rata share of the portfolio company''s equity; and where the fund holds more than one class in the same company, whether those classes are measured together or separately and why', 25),
  ('01N409NARR0000000000000047', 'fund', 'valuation_methodology', 'Valuation Techniques',
   'the technique applied to each holding and why it suits that position — an unadjusted quoted price, the price of the most recent orderly financing in the same security, an option-pricing allocation calibrated to the transaction price at the investment date and rolled forward, or cost where no calibrating event has occurred since acquisition. This is a technique per holding, not a weighting of approaches across the fund',
   'the technique applied to each holding and why it suits that position — an unadjusted quoted price, the price of the most recent orderly financing in the same security, an option-pricing allocation calibrated to the transaction price at the investment date and rolled forward, or cost where no calibrating event has occurred since acquisition. This is a technique per holding, not a weighting of approaches across the fund', 30),
  ('01N409NARR0000000000000048', 'fund', 'fair_value_hierarchy', 'Fair Value Hierarchy',
   'the level each measurement is classified into and the inputs that drive the classification, together with any transfer between levels since the prior measurement date and what caused it — a holding leaving Level 3 on an IPO, or entering it when the market for its class ceased to be active',
   'the level each measurement is classified into and the inputs that drive the classification, together with any transfer between levels since the prior measurement date and what caused it — a holding leaving Level 3 on an IPO, or entering it when the market for its class ceased to be active', 45),
  ('01N409NARR0000000000000049', 'fund', 'unobservable_inputs', 'Significant Unobservable Inputs',
   'each significant unobservable input behind the Level 3 holdings — volatility, time to exit, the marketability discount, the calibrated equity value — its range across the portfolio, its weighted average, and the sensitivity of the measurement to it, as ASC 820-10-50-2 requires',
   'each significant unobservable input behind the Level 3 holdings — volatility, time to exit, the marketability discount, the calibrated equity value — its range across the portfolio, its weighted average, and the sensitivity of the measurement to it, as ASC 820-10-50-2 requires', 55),
  ('01N409NARR0000000000000050', 'fund', 'lp_economics', 'Partnership Economics',
   'how the net asset value would be distributed under the partnership agreement — return of capital, the preferred return, any general partner catch-up, and the carried interest split — and whether a clawback would be owed on a hypothetical liquidation at this net asset value',
   'how the net asset value would be distributed under the partnership agreement — return of capital, the preferred return, any general partner catch-up, and the carried interest split — and whether a clawback would be owed on a hypothetical liquidation at this net asset value', 75),
  ('01N409NARR0000000000000051', 'fund', 'conclusion', 'Net Asset Value',
   'the concluded gross asset value, the fund-level liabilities deducted from it, the resulting net asset value, and the unrealized gain or loss against cost',
   'the concluded gross asset value, the fund-level liabilities deducted from it, the resulting net asset value, and the unrealized gain or loss against cost', 80)
ON CONFLICT (kind, section_key) DO NOTHING;

INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000052', 'fund', 'company_overview', 'Company Overview and Industry Analysis',
   'what the company does, its stage and traction, and the industry it competes in',
   'what the company does, its stage and traction, and the industry it competes in', 20, false),
  ('01N409NARR0000000000000053', 'fund', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 40, false),
  ('01N409NARR0000000000000054', 'fund', 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 50, false),
  ('01N409NARR0000000000000055', 'fund', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false),
  -- A marketability discount here is an input to one holding's measurement,
  -- disclosed in the Level 3 table above; it is not a chapter of the report.
  ('01N409NARR0000000000000056', 'fund', 'dlom_analysis', 'Discount for Lack of Marketability',
   'the DLOM method chosen, the factors considered, and the resulting discount',
   'the DLOM method chosen, the factors considered, and the resulting discount', 70, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ── Debt: an obligation priced off its credit ───────────────────────────────
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000057', 'debt', 'instrument_terms', 'Instrument & Terms',
   'the instrument itself: its form, principal, coupon and payment frequency, maturity, amortization, seniority and security, and any embedded conversion or prepayment right',
   'the instrument itself: its form, principal, coupon and payment frequency, maturity, amortization, seniority and security, and any embedded conversion or prepayment right', 15),
  -- Routed into the Credit Assessment chapter, so this is what it must be about.
  ('01N409NARR0000000000000058', 'debt', 'company_overview', 'Credit Assessment',
   'the issuer''s credit: the rating or rating equivalent applied and the basis for it, the instrument''s position in the capital structure, and any security or covenant that alters expected recovery — and how that assessment maps to the credit spread applied in the discount rate',
   'the issuer''s credit: the rating or rating equivalent applied and the basis for it, the instrument''s position in the capital structure, and any security or covenant that alters expected recovery — and how that assessment maps to the credit spread applied in the discount rate', 20),
  ('01N409NARR0000000000000059', 'debt', 'standard_of_value', 'Standard of Value',
   'fair value as an ASC 820 exit price — what a market participant would pay for the issuer''s contractual obligation given its credit quality and the yields available on comparable credits — and that this is neither the carrying amount nor the amount recoverable on enforcement',
   'fair value as an ASC 820 exit price — what a market participant would pay for the issuer''s contractual obligation given its credit quality and the yields available on comparable credits — and that this is neither the carrying amount nor the amount recoverable on enforcement', 25),
  ('01N409NARR0000000000000060', 'debt', 'valuation_methodology', 'Valuation Methodology',
   'the measurement this instrument calls for: contractual interest and principal discounted at the all-in yield for straight debt, stated as a dirty price with accrued interest identified separately; the straight-debt value together with the conversion right for a convertible, so the measurement is never below conversion parity; or the conversion terms that would apply at the next priced round for a SAFE, stating whether the valuation cap or the discount governs',
   'the measurement this instrument calls for: contractual interest and principal discounted at the all-in yield for straight debt, stated as a dirty price with accrued interest identified separately; the straight-debt value together with the conversion right for a convertible, so the measurement is never below conversion parity; or the conversion terms that would apply at the next priced round for a SAFE, stating whether the valuation cap or the discount governs', 30),
  -- Routed into the Discount Rate chapter.
  ('01N409NARR0000000000000061', 'debt', 'income_approach', 'Discount Rate',
   'the build-up of the yield the contractual cash flows are discounted at: the benchmark yield at the matching tenor, the credit spread for the assessed rating and seniority, and any adjustment for illiquidity or an instrument-specific feature',
   'the build-up of the yield the contractual cash flows are discounted at: the benchmark yield at the matching tenor, the credit spread for the assessed rating and seniority, and any adjustment for illiquidity or an instrument-specific feature', 50),
  ('01N409NARR0000000000000062', 'debt', 'sensitivity', 'Interest-Rate Sensitivity',
   'the instrument''s duration and convexity and what they imply for the measurement under a parallel shift in yields; where the instrument carries an embedded option, that duration alone does not describe how it behaves',
   'the instrument''s duration and convexity and what they imply for the measurement under a parallel shift in yields; where the instrument carries an embedded option, that duration alone does not describe how it behaves', 65),
  ('01N409NARR0000000000000063', 'debt', 'conclusion', 'Conclusion of Value',
   'the concluded fair value of the instrument at the measurement date, with accrued interest identified separately where the price is quoted clean, and any premium or discount to par',
   'the concluded fair value of the instrument at the measurement date, with accrued interest identified separately where the price is quoted clean, and any premium or discount to par', 80)
ON CONFLICT (kind, section_key) DO NOTHING;

INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000064', 'debt', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 40, false),
  ('01N409NARR0000000000000065', 'debt', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false),
  ('01N409NARR0000000000000066', 'debt', 'dlom_analysis', 'Discount for Lack of Marketability',
   'the DLOM method chosen, the factors considered, and the resulting discount',
   'the DLOM method chosen, the factors considered, and the resulting discount', 70, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ── Goodwill & intangible impairment (ASC 350/360) ──────────────────────────
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000067', 'goodwill', 'reporting_units', 'Reporting Units & Asset Groups',
   'the reporting units and long-lived asset groups tested, the carrying amount of each on the books, and the sequencing applied — ASC 360 asset groups first, then indefinite-lived intangibles, then goodwill',
   'the reporting units and long-lived asset groups tested, the carrying amount of each on the books, and the sequencing applied — ASC 360 asset groups first, then indefinite-lived intangibles, then goodwill', 15),
  ('01N409NARR0000000000000068', 'goodwill', 'qualitative_assessment', 'Qualitative Assessment',
   'where a step-zero assessment was performed, the events and circumstances weighed and why they did or did not indicate that fair value more likely than not falls below carrying amount',
   'where a step-zero assessment was performed, the events and circumstances weighed and why they did or did not indicate that fair value more likely than not falls below carrying amount', 25),
  ('01N409NARR0000000000000069', 'goodwill', 'valuation_methodology', 'Quantitative Tests',
   'for each unit or asset group tested quantitatively: how its fair value was determined and by what method, the recoverability screen against undiscounted cash flows that ASC 360-10 requires for a long-lived asset group, and the resulting comparison to carrying amount',
   'for each unit or asset group tested quantitatively: how its fair value was determined and by what method, the recoverability screen against undiscounted cash flows that ASC 360-10 requires for a long-lived asset group, and the resulting comparison to carrying amount', 30),
  ('01N409NARR0000000000000070', 'goodwill', 'conclusion', 'Conclusion',
   'each impairment loss recognized — or that none was — the carrying amounts after measurement, and the remaining headroom by reporting unit',
   'each impairment loss recognized — or that none was — the carrying amounts after measurement, and the remaining headroom by reporting unit', 80)
ON CONFLICT (kind, section_key) DO NOTHING;

INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000071', 'goodwill', 'company_overview', 'Company Overview and Industry Analysis',
   'what the company does, its stage and traction, and the industry it competes in',
   'what the company does, its stage and traction, and the industry it competes in', 20, false),
  ('01N409NARR0000000000000072', 'goodwill', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 40, false),
  ('01N409NARR0000000000000073', 'goodwill', 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 50, false),
  ('01N409NARR0000000000000074', 'goodwill', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false),
  ('01N409NARR0000000000000075', 'goodwill', 'dlom_analysis', 'Discount for Lack of Marketability',
   'the DLOM method chosen, the factors considered, and the resulting discount',
   'the DLOM method chosen, the factors considered, and the resulting discount', 70, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ── Intellectual property: an asset, not a business ─────────────────────────
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000076', 'ip', 'asset_description', 'Subject Asset',
   'the asset itself — patents, trademarks, software, trade secrets — the legal protection it carries, its remaining economic life set against its remaining legal life, and precisely which rights are being valued',
   'the asset itself — patents, trademarks, software, trade secrets — the legal protection it carries, its remaining economic life set against its remaining legal life, and precisely which rights are being valued', 15),
  ('01N409NARR0000000000000077', 'ip', 'valuation_methodology', 'Valuation Methods',
   'the method applied — relief-from-royalty, multi-period excess earnings, with-and-without, or replacement cost less obsolescence — why it suits this asset, and its key assumptions: the royalty rate selected and the comparable license agreements supporting it, the discount rate, and the tax amortization benefit where one applies',
   'the method applied — relief-from-royalty, multi-period excess earnings, with-and-without, or replacement cost less obsolescence — why it suits this asset, and its key assumptions: the royalty rate selected and the comparable license agreements supporting it, the discount rate, and the tax amortization benefit where one applies', 30),
  ('01N409NARR0000000000000078', 'ip', 'conclusion', 'Conclusion of Value',
   'the concluded fair value of the subject asset and the limiting conditions the conclusion is subject to',
   'the concluded fair value of the subject asset and the limiting conditions the conclusion is subject to', 80)
ON CONFLICT (kind, section_key) DO NOTHING;

INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000079', 'ip', 'company_overview', 'Company Overview and Industry Analysis',
   'what the company does, its stage and traction, and the industry it competes in',
   'what the company does, its stage and traction, and the industry it competes in', 20, false),
  ('01N409NARR0000000000000080', 'ip', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 40, false),
  ('01N409NARR0000000000000081', 'ip', 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 50, false),
  ('01N409NARR0000000000000082', 'ip', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false),
  ('01N409NARR0000000000000083', 'ip', 'dlom_analysis', 'Discount for Lack of Marketability',
   'the DLOM method chosen, the factors considered, and the resulting discount',
   'the DLOM method chosen, the factors considered, and the resulting discount', 70, false)
ON CONFLICT (kind, section_key) DO NOTHING;
