-- Narrative prompt library, part three: the last six deliverables that were
-- still being drafted with the 409A's guidance.
--
-- 0114 seeded the base library and five kinds; 0141 converted five more and
-- left a named list behind — csop, emi, esop, fmv, gifts, ifrs2 — as the
-- remaining gap. This closes it, and the test that held the list
-- (`narrativeApply.test.ts`, "gives a renamed chapter its own guidance") now
-- expects it empty.
--
-- The defect is the same one 0141 describes. `NARRATIVE_SECTION_MAP_BY_KIND`
-- routes a drafted section into the chapter a skeleton actually has, which
-- gets the prose onto the right page and does nothing about what the prose is
-- about. On these six the routing lands several sections under a heading that
-- wants a different subject entirely:
--
--   * `esop.dlom_analysis` → "Level of Value & Discounts". The agent was asked
--     for "the DLOM method chosen, the factors considered, and the resulting
--     discount", and the chapter wants the whole chain: the level at which the
--     ESOP transacts, the control adjustment, *then* marketability. A DOL
--     investigator reads that chapter for the level-of-value argument, and it
--     was being drafted as though there were none.
--   * `emi.dlom_analysis` → "UMV and AMV". Not a discount discussion at all —
--     it is the statutory pair HMRC agrees, and the restrictions that separate
--     them. Drafting it from restricted-stock studies produces a chapter that
--     answers a question the form does not ask.
--   * `csop/emi.valuation_methodology` → "Valuation Analysis",
--     `esop.valuation_methodology` → "Valuation Approaches",
--     `fmv.valuation_methodology` → "Valuation Methods",
--     `gifts.valuation_methodology` → "Valuation of the Underlying Entity",
--     `ifrs2.valuation_methodology` → "Valuation Model & Assumptions". The base
--     guidance is "which approaches were used and how they were weighted",
--     which is a 409A's three-approach reconciliation. An IFRS 2 measurement
--     weights nothing; it picks a model and defends five inputs. An SMB
--     opinion capitalises normalised earnings. A gift valuation reconciles
--     asset, income and market indications *before* the interest-level
--     discounts, and saying so is what makes the discount chapter legible.
--   * `gifts.dlom_analysis` → "Interest-Level Discounts", shared with `dloc`
--     (0114 already owns that half). The chapter argues both discounts and
--     states the order of application; the base guidance neither knows there is
--     a second discount nor that the order matters.
--
-- And the chapters only these skeletons have — the scheme-qualification
-- conditions HMRC checks first, the ESOP's repurchase obligation, the awards
-- an IFRS 2 report measures, the §§2701–2704 tests — had no library row at
-- all, so nothing was drafted for them and they shipped carrying the
-- skeleton's instructions to the analyst.
--
-- Row conventions as 0141: keyed to the chapter the map routes to so nothing
-- has to change in code, `guidance` and `default_guidance` seeded identical so
-- "reset" is a no-op until somebody edits, and the suppressions given the base
-- library's own wording so turning one back on yields the standard text rather
-- than a stub.

-- ── CSOP: a Schedule 4 scheme values at unrestricted market value ───────────
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000084', 'csop', 'executive_summary', 'Executive Summary',
   'the company, the class of shares under option, the valuation date, and the unrestricted market value per share proposed to HMRC for agreement on form VAL230',
   'the company, the class of shares under option, the valuation date, and the unrestricted market value per share proposed to HMRC for agreement on form VAL230', 10),
  ('01N409NARR0000000000000085', 'csop', 'valuation_methodology', 'Valuation Analysis',
   'how the company''s equity value was reached and the unrestricted market value per share derived from it: the approach taken and why it suits a company at this stage, the discount for the minority holding an option-holder would take, and — because a CSOP option is granted at market value — the fact that no restriction discount is taken, since a Schedule 4 scheme values on the unrestricted basis',
   'how the company''s equity value was reached and the unrestricted market value per share derived from it: the approach taken and why it suits a company at this stage, the discount for the minority holding an option-holder would take, and — because a CSOP option is granted at market value — the fact that no restriction discount is taken, since a Schedule 4 scheme values on the unrestricted basis', 30),
  ('01N409NARR0000000000000086', 'csop', 'scheme_limits', 'Scheme Qualification',
   'the Schedule 4 conditions tested at grant: the £60,000 individual limit measured on unrestricted market value, that the exercise price is not manifestly less than the market value of the shares at grant, and that the shares are ordinary, fully paid and non-redeemable — state the thresholds as they stand at the valuation date, since they move with the Finance Act',
   'the Schedule 4 conditions tested at grant: the £60,000 individual limit measured on unrestricted market value, that the exercise price is not manifestly less than the market value of the shares at grant, and that the shares are ordinary, fully paid and non-redeemable — state the thresholds as they stand at the valuation date, since they move with the Finance Act', 45),
  ('01N409NARR0000000000000087', 'csop', 'conclusion', 'Conclusion',
   'the concluded market value per share proposed for agreement with HMRC, the date it is offered as at, and the period for which an agreed valuation is normally held good — this is a figure offered for agreement, not a determination, and the wording should not claim otherwise',
   'the concluded market value per share proposed for agreement with HMRC, the date it is offered as at, and the period for which an agreed valuation is normally held good — this is a figure offered for agreement, not a determination, and the wording should not claim otherwise', 80)
ON CONFLICT (kind, section_key) DO NOTHING;

INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000088', 'csop', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 40, false),
  ('01N409NARR0000000000000089', 'csop', 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 50, false),
  ('01N409NARR0000000000000090', 'csop', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false),
  ('01N409NARR0000000000000091', 'csop', 'dlom_analysis', 'Discount for Lack of Marketability',
   'the DLOM method chosen, the factors considered, and the resulting discount',
   'the DLOM method chosen, the factors considered, and the resulting discount', 70, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ── EMI: the UMV/AMV pair is the deliverable, not a discount discussion ─────
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000092', 'emi', 'executive_summary', 'Executive Summary',
   'the company, the class of shares under option, the valuation date, and both figures proposed to HMRC for agreement on form VAL231 — the unrestricted market value and the actual market value per share',
   'the company, the class of shares under option, the valuation date, and both figures proposed to HMRC for agreement on form VAL231 — the unrestricted market value and the actual market value per share', 10),
  ('01N409NARR0000000000000093', 'emi', 'valuation_methodology', 'Valuation Analysis',
   'how the company''s equity value was reached and the per-share value derived from it: the approach taken and why it suits a company at this stage, the treatment of any preference held by investors, and the discount appropriate to the small minority holding an option-holder acquires — this chapter reaches the unrestricted value, and the restrictions are argued separately',
   'how the company''s equity value was reached and the per-share value derived from it: the approach taken and why it suits a company at this stage, the treatment of any preference held by investors, and the discount appropriate to the small minority holding an option-holder acquires — this chapter reaches the unrestricted value, and the restrictions are argued separately', 30),
  ('01N409NARR0000000000000094', 'emi', 'dlom_analysis', 'UMV and AMV',
   'the unrestricted market value and the actual market value per share, and the restrictions in the articles that separate them: compulsory-transfer and leaver provisions, pre-emption rights, drag and tag, and any restriction on voting or dividends. State the discount taken from UMV to AMV and which specific restriction supports it. This is not a marketability discount — it is the statutory distinction in ITEPA 2003 s.531 between value ignoring restrictions and value taking them into account, and the two figures are what HMRC agrees',
   'the unrestricted market value and the actual market value per share, and the restrictions in the articles that separate them: compulsory-transfer and leaver provisions, pre-emption rights, drag and tag, and any restriction on voting or dividends. State the discount taken from UMV to AMV and which specific restriction supports it. This is not a marketability discount — it is the statutory distinction in ITEPA 2003 s.531 between value ignoring restrictions and value taking them into account, and the two figures are what HMRC agrees', 45),
  ('01N409NARR0000000000000095', 'emi', 'scheme_limits', 'Scheme Qualification',
   'the Schedule 5 conditions tested at grant: gross assets within the ceiling, the full-time-equivalent employee limit, the individual and company limits measured on unrestricted market value, the working-time requirement, and that the trade is a qualifying one. State the thresholds as they stand at the valuation date, since they move with the Finance Act, and name any condition that is met only marginally',
   'the Schedule 5 conditions tested at grant: gross assets within the ceiling, the full-time-equivalent employee limit, the individual and company limits measured on unrestricted market value, the working-time requirement, and that the trade is a qualifying one. State the thresholds as they stand at the valuation date, since they move with the Finance Act, and name any condition that is met only marginally', 55),
  ('01N409NARR0000000000000096', 'emi', 'conclusion', 'Conclusion',
   'the concluded UMV and AMV per share proposed for agreement with HMRC, the date they are offered as at, and the period an agreed valuation is normally held good — these are figures offered for agreement, not a determination',
   'the concluded UMV and AMV per share proposed for agreement with HMRC, the date they are offered as at, and the period an agreed valuation is normally held good — these are figures offered for agreement, not a determination', 80)
ON CONFLICT (kind, section_key) DO NOTHING;

INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000097', 'emi', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 40, false),
  ('01N409NARR0000000000000098', 'emi', 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 50, false),
  ('01N409NARR0000000000000099', 'emi', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ── ESOP: adequate consideration, and the chain through level of value ──────
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000100', 'esop', 'executive_summary', 'Executive Summary',
   'the sponsor, the plan, the valuation date, the concluded fair market value per share, and that the opinion is prepared for the trustee for purposes of the ERISA §3(18) adequate-consideration standard',
   'the sponsor, the plan, the valuation date, the concluded fair market value per share, and that the opinion is prepared for the trustee for purposes of the ERISA §3(18) adequate-consideration standard', 10),
  ('01N409NARR0000000000000101', 'esop', 'valuation_methodology', 'Valuation Approaches',
   'the income and market approaches applied to the enterprise, argued together and reconciled here rather than in separate chapters: the projection and the discount-rate build-up, the guideline companies or transactions and the multiples drawn from them, what each indicated, and the weighting between them. Where the sponsor is an S corporation, state how the pass-through tax status was treated and why, since it is the assumption most often challenged',
   'the income and market approaches applied to the enterprise, argued together and reconciled here rather than in separate chapters: the projection and the discount-rate build-up, the guideline companies or transactions and the multiples drawn from them, what each indicated, and the weighting between them. Where the sponsor is an S corporation, state how the pass-through tax status was treated and why, since it is the assumption most often challenged', 30),
  ('01N409NARR0000000000000102', 'esop', 'dlom_analysis', 'Level of Value & Discounts',
   'the whole chain from the concluded equity value to the per-share value, in order: the level of value at which the plan transacts and why (a controlling interest where the ESOP holds one and the trustee can exercise it, minority where it cannot), the control premium or discount for lack of control that follows, and then the discount for lack of marketability — reduced, and stated as reduced, by any put right the plan confers under IRC §409(h). Give the support for each adjustment. A discount that appears in the arithmetic and not in the prose is the finding a Department of Labor investigation opens with',
   'the whole chain from the concluded equity value to the per-share value, in order: the level of value at which the plan transacts and why (a controlling interest where the ESOP holds one and the trustee can exercise it, minority where it cannot), the control premium or discount for lack of control that follows, and then the discount for lack of marketability — reduced, and stated as reduced, by any put right the plan confers under IRC §409(h). Give the support for each adjustment. A discount that appears in the arithmetic and not in the prose is the finding a Department of Labor investigation opens with', 45),
  ('01N409NARR0000000000000103', 'esop', 'repurchase_obligation', 'Repurchase Obligation',
   'the projected liability to repurchase shares from departing participants: the redemption assumptions behind it (turnover, retirement, mortality, diversification elections), the share-value growth assumed, the resulting schedule and its present value, and whether the sponsor''s expected cash flow services it — an obligation the projection ignores is one the enterprise value has not been charged for',
   'the projected liability to repurchase shares from departing participants: the redemption assumptions behind it (turnover, retirement, mortality, diversification elections), the share-value growth assumed, the resulting schedule and its present value, and whether the sponsor''s expected cash flow services it — an obligation the projection ignores is one the enterprise value has not been charged for', 55),
  ('01N409NARR0000000000000104', 'esop', 'conclusion', 'Conclusion of Value',
   'the concluded fair market value per share and of the plan''s holding as of the valuation date, and the statement that the price is not more than adequate consideration for a purchase or not less for a sale — with the direction of the transaction named, since the standard is asymmetric',
   'the concluded fair market value per share and of the plan''s holding as of the valuation date, and the statement that the price is not more than adequate consideration for a purchase or not less for a sale — with the direction of the transaction named, since the standard is asymmetric', 80)
ON CONFLICT (kind, section_key) DO NOTHING;

INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000105', 'esop', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 40, false),
  ('01N409NARR0000000000000106', 'esop', 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 50, false),
  ('01N409NARR0000000000000107', 'esop', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ── SMB fair market value: normalized earnings, not a three-approach 409A ───
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000108', 'fmv', 'executive_summary', 'Executive Summary',
   'the business, the valuation date, the purpose of the opinion, the standard and premise of value, and the concluded fair market value — stated on the basis the conclusion is struck on (debt-free, cash-free, with a normal level of working capital) rather than as a bare number',
   'the business, the valuation date, the purpose of the opinion, the standard and premise of value, and the concluded fair market value — stated on the basis the conclusion is struck on (debt-free, cash-free, with a normal level of working capital) rather than as a bare number', 10),
  ('01N409NARR0000000000000109', 'fmv', 'earnings_normalization', 'Normalized Earnings (SDE)',
   'the build from reported pre-tax income to seller''s discretionary earnings: each add-back named and quantified — owner compensation, interest, depreciation and amortisation, one-time and non-operating items, and personal expenses run through the business — and the replacement wage deducted for the owner''s working role. State which add-backs a buyer would contest, because a normalisation nobody can defend is what a transaction re-prices on',
   'the build from reported pre-tax income to seller''s discretionary earnings: each add-back named and quantified — owner compensation, interest, depreciation and amortisation, one-time and non-operating items, and personal expenses run through the business — and the replacement wage deducted for the owner''s working role. State which add-backs a buyer would contest, because a normalisation nobody can defend is what a transaction re-prices on', 25),
  ('01N409NARR0000000000000110', 'fmv', 'valuation_methodology', 'Valuation Methods',
   'the methods applied to normalized earnings and the support for each: the capitalization rate and the build-up behind it, the SDE or EBITDA multiple and the transaction evidence it comes from, and any rule-of-thumb revenue multiple used as a cross-check rather than as an indication. Name the owner-dependence, customer concentration and transferability facts that moved the multiple within its range — that judgement is the analysis, and a multiple asserted without it is a quotation',
   'the methods applied to normalized earnings and the support for each: the capitalization rate and the build-up behind it, the SDE or EBITDA multiple and the transaction evidence it comes from, and any rule-of-thumb revenue multiple used as a cross-check rather than as an indication. Name the owner-dependence, customer concentration and transferability facts that moved the multiple within its range — that judgement is the analysis, and a multiple asserted without it is a quotation', 30),
  ('01N409NARR0000000000000111', 'fmv', 'conclusion', 'Conclusion of Value',
   'the weighting of the method indications and the concluded fair market value, with the transaction conventions the figure assumes stated explicitly — debt-free and cash-free, a normal level of working capital delivered, and what is included in and excluded from the assets conveyed',
   'the weighting of the method indications and the concluded fair market value, with the transaction conventions the figure assumes stated explicitly — debt-free and cash-free, a normal level of working capital delivered, and what is included in and excluded from the assets conveyed', 80)
ON CONFLICT (kind, section_key) DO NOTHING;

INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000112', 'fmv', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 40, false),
  ('01N409NARR0000000000000113', 'fmv', 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 50, false),
  ('01N409NARR0000000000000114', 'fmv', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false),
  ('01N409NARR0000000000000115', 'fmv', 'dlom_analysis', 'Discount for Lack of Marketability',
   'the DLOM method chosen, the factors considered, and the resulting discount',
   'the DLOM method chosen, the factors considered, and the resulting discount', 70, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ── Gift & estate: the entity, then the interest ────────────────────────────
--
-- 0114 owns `revenue_ruling_factors` and `dloc`. These are the rest: the
-- entity-level valuation the factor walk shares a chapter with, the
-- marketability half of "Interest-Level Discounts", and the Chapter 14 tests
-- that had no row at all.
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000116', 'gifts', 'valuation_methodology', 'Valuation of the Underlying Entity',
   'the approaches applied to the entity before any interest-level adjustment — asset, income and market — what each indicated, and the weighting that reached the concluded entity value. Where the entity is a holding company the net asset value governs and the reason should be stated; where it operates, say why the earnings evidence is given the weight it is. Everything in this chapter is at the whole-entity level: the discounts come afterwards and applying one here would double-count it',
   'the approaches applied to the entity before any interest-level adjustment — asset, income and market — what each indicated, and the weighting that reached the concluded entity value. Where the entity is a holding company the net asset value governs and the reason should be stated; where it operates, say why the earnings evidence is given the weight it is. Everything in this chapter is at the whole-entity level: the discounts come afterwards and applying one here would double-count it', 30),
  ('01N409NARR0000000000000117', 'gifts', 'dlom_analysis', 'Discount for Lack of Marketability',
   'the marketability discount on the transferred interest and its support: the restricted-stock or pre-IPO evidence or the option-based model relied on, and the Mandelbaum factors weighed against this interest — distribution history, the holding period a buyer faces, the transfer restrictions in the governing documents, and how large the pool of likely buyers really is. State the order in which this discount and the control discount are applied, since applying them in the other order gives a different answer and the report has to own which one it took',
   'the marketability discount on the transferred interest and its support: the restricted-stock or pre-IPO evidence or the option-based model relied on, and the Mandelbaum factors weighed against this interest — distribution history, the holding period a buyer faces, the transfer restrictions in the governing documents, and how large the pool of likely buyers really is. State the order in which this discount and the control discount are applied, since applying them in the other order gives a different answer and the report has to own which one it took', 70),
  ('01N409NARR0000000000000118', 'gifts', 'chapter_14', 'Chapter 14 Considerations',
   'the special valuation rules of IRC §§2701–2704, each addressed or expressly dismissed as inapplicable: whether any retained distribution right is valued at zero under §2701, whether a lapsing voting or liquidation right is disregarded under §2704, and whether a buy-sell or option agreement meets the §2703 tests (a bona fide business arrangement, not a device to transfer to family for less than full consideration, and terms comparable to an arm''s-length arrangement). Silence on a rule that applies is what reopens the assessment period',
   'the special valuation rules of IRC §§2701–2704, each addressed or expressly dismissed as inapplicable: whether any retained distribution right is valued at zero under §2701, whether a lapsing voting or liquidation right is disregarded under §2704, and whether a buy-sell or option agreement meets the §2703 tests (a bona fide business arrangement, not a device to transfer to family for less than full consideration, and terms comparable to an arm''s-length arrangement). Silence on a rule that applies is what reopens the assessment period', 75)
ON CONFLICT (kind, section_key) DO NOTHING;

INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000119', 'gifts', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 40, false),
  ('01N409NARR0000000000000120', 'gifts', 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 50, false),
  ('01N409NARR0000000000000121', 'gifts', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ── IFRS 2: a model and five inputs, not a weighting of approaches ──────────
--
-- 0114 owns `measurement_basis` and `vesting_conditions`, and suppressed the
-- allocation. These are the model chapter the methodology section routes into,
-- the awards chapter that had no row, and the rest of the 409A furniture.
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000122', 'ifrs2', 'awards', 'Awards Measured',
   'the arrangements measured: the instrument granted, the grant date and the counterparties, the number of awards, the exercise price, the vesting conditions attached (service, performance, market), and whether settlement is in equity or cash — the last of these determines whether the measurement is fixed at grant or remeasured every reporting date, so it is stated per arrangement rather than once for the plan',
   'the arrangements measured: the instrument granted, the grant date and the counterparties, the number of awards, the exercise price, the vesting conditions attached (service, performance, market), and whether settlement is in equity or cash — the last of these determines whether the measurement is fixed at grant or remeasured every reporting date, so it is stated per arrangement rather than once for the plan', 35),
  ('01N409NARR0000000000000123', 'ifrs2', 'valuation_methodology', 'Valuation Model & Assumptions',
   'the model applied and why it is capable of measuring this award — Black-Scholes-Merton for a plain option, a binomial lattice where early exercise or a graded structure requires one, Monte-Carlo simulation where a market condition is attached, since a closed-form model cannot value one — and the basis for each input: the share price at grant date and its source, the expected life reflecting exercise behaviour and any post-vesting restriction, the expected volatility and the period it was measured over, the risk-free rate matched to that life, and expected dividends. This chapter defends inputs; it does not weight approaches',
   'the model applied and why it is capable of measuring this award — Black-Scholes-Merton for a plain option, a binomial lattice where early exercise or a graded structure requires one, Monte-Carlo simulation where a market condition is attached, since a closed-form model cannot value one — and the basis for each input: the share price at grant date and its source, the expected life reflecting exercise behaviour and any post-vesting restriction, the expected volatility and the period it was measured over, the risk-free rate matched to that life, and expected dividends. This chapter defends inputs; it does not weight approaches', 40)
ON CONFLICT (kind, section_key) DO NOTHING;

INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000124', 'ifrs2', 'company_overview', 'Company Overview and Industry Analysis',
   'what the company does, its stage and traction, and the industry it competes in',
   'what the company does, its stage and traction, and the industry it competes in', 20, false),
  ('01N409NARR0000000000000125', 'ifrs2', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 50, false),
  ('01N409NARR0000000000000126', 'ifrs2', 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 55, false),
  ('01N409NARR0000000000000127', 'ifrs2', 'dlom_analysis', 'Discount for Lack of Marketability',
   'the DLOM method chosen, the factors considered, and the resulting discount',
   'the DLOM method chosen, the factors considered, and the resulting discount', 70, false),
  ('01N409NARR0000000000000128', 'ifrs2', 'conclusion', 'Conclusion and Fair Market Value',
   'the reconciliation across approaches and the final concluded fair market value per common share',
   'the reconciliation across approaches and the final concluded fair market value per common share', 80, false)
ON CONFLICT (kind, section_key) DO NOTHING;
