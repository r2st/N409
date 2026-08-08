-- Narrative prompt library: the per-section guidance the report_narrative
-- agent drafts against, as editable rows rather than a Python tuple.
--
-- The agent has always held its eight sections and their guidance in
-- `SECTIONS` (ai/app/agents/report_narrative.py). That is one prompt for every
-- firm, every deliverable and every section, and it means the two things a
-- reviewer most often wants changed — how the DLOM discussion is framed, and
-- how the conclusion is worded — cannot be changed without a deploy.
--
-- Splitting it out is not the same job as `ai_prompts`, which holds ONE system
-- prompt per pipeline: that prompt says who the model is, and these say what
-- each section must cover. A firm editing "be more conservative about forward
-- multiples" is editing a section, not a persona.
--
-- Two axes, and the composite key is (kind, section_key):
--
--   * `kind` NULL is the base library — the sections any deliverable gets.
--   * `kind` set overrides or adds sections for that report type. A QSBS
--     memorandum has no DLOM discussion and does have four §1202 tests; a PPA
--     has no allocation methodology and does have an intangibles walk. Seeding
--     one list for all fifteen kinds is how the specialty deliverables ended up
--     reading as a 409A with the title swapped, which domain/report.ts already
--     went to some trouble to stop.

CREATE TABLE IF NOT EXISTS narrative_prompts (
  id             ulid PRIMARY KEY,
  -- NULL = the base library, applying to any deliverable without an override.
  kind           valuation_kind,
  section_key    text        NOT NULL,
  label          text        NOT NULL,
  -- What the section must cover, in the words handed to the model.
  guidance       text        NOT NULL,
  -- Ordering within the drafted narrative. Sparse so a section can be inserted
  -- between two others without renumbering the library.
  sort_order     integer     NOT NULL DEFAULT 100,
  -- Off means "do not draft this section". Kept rather than deleted so a firm
  -- that turns one off still has the default text to turn back on.
  enabled        boolean     NOT NULL DEFAULT true,
  -- The seeded text, never overwritten by an edit. This is what "reset" means;
  -- without it the only way back to the default is a redeploy.
  default_guidance text      NOT NULL,
  updated_by     ulid        REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per (kind, section). NULLS NOT DISTINCT so the base library is
-- covered by the same constraint — without it, `kind IS NULL` rows could be
-- inserted twice and the loader would silently pick one.
CREATE UNIQUE INDEX IF NOT EXISTS narrative_prompts_kind_section_uq
  ON narrative_prompts (kind, section_key) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS narrative_prompts_kind_idx
  ON narrative_prompts (kind) WHERE enabled;

COMMENT ON TABLE narrative_prompts IS
  'Per-section guidance for the report_narrative agent; (kind, section_key) unique, kind NULL = base library.';
COMMENT ON COLUMN narrative_prompts.default_guidance IS
  'The seeded text, preserved so an edited row can be reset without a redeploy.';

-- ── the base library ────────────────────────────────────────────────────────
--
-- These eight mirror the agent's built-in SECTIONS exactly, so behaviour is
-- unchanged until someone edits one. `guidance` and `default_guidance` are
-- seeded identical for the same reason.
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000001', NULL, 'executive_summary', 'Executive Summary',
   'the engagement, the concluded fair market value per share, the valuation date, and the standard of value',
   'the engagement, the concluded fair market value per share, the valuation date, and the standard of value', 10),
  ('01N409NARR0000000000000002', NULL, 'company_overview', 'Company Overview and Industry Analysis',
   'what the company does, its stage and traction, and the industry it competes in',
   'what the company does, its stage and traction, and the industry it competes in', 20),
  ('01N409NARR0000000000000003', NULL, 'valuation_methodology', 'Valuation Methodology',
   'which approaches were used, why they fit this company, and how they were weighted',
   'which approaches were used, why they fit this company, and how they were weighted', 30),
  ('01N409NARR0000000000000004', NULL, 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied — state whether each multiple is struck on a trailing (LTM) or forward (NTM) basis, since the two are not interchangeable',
   'the guideline public companies selected, the selection rationale, and the multiples applied — state whether each multiple is struck on a trailing (LTM) or forward (NTM) basis, since the two are not interchangeable', 40),
  ('01N409NARR0000000000000005', NULL, 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 50),
  ('01N409NARR0000000000000006', NULL, 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60),
  ('01N409NARR0000000000000007', NULL, 'dlom_analysis', 'Discount for Lack of Marketability',
   'the DLOM method chosen, the factors considered, and the resulting discount — where the method is an upper bound (Longstaff) or a blend of published studies (restricted stock), say so and name the studies',
   'the DLOM method chosen, the factors considered, and the resulting discount — where the method is an upper bound (Longstaff) or a blend of published studies (restricted stock), say so and name the studies', 70),
  ('01N409NARR0000000000000008', NULL, 'conclusion', 'Conclusion and Fair Market Value',
   'the reconciliation across approaches and the final concluded fair market value per common share',
   'the reconciliation across approaches and the final concluded fair market value per common share', 80)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ── specialty overrides ─────────────────────────────────────────────────────
--
-- Only where the deliverable genuinely differs. A kind with no rows here falls
-- back to the base library, which is the right answer for most of them — an
-- FMV opinion and a 409A really do want the same eight sections.

-- QSBS §1202: four statutory tests, no allocation, no DLOM.
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000009', 'qsbs', 'executive_summary', 'Executive Summary',
   'the shareholder, the stock under review, and whether it qualifies as Qualified Small Business Stock under IRC 1202',
   'the shareholder, the stock under review, and whether it qualifies as Qualified Small Business Stock under IRC 1202', 10),
  ('01N409NARR0000000000000010', 'qsbs', 'entity_test', 'Eligible Entity',
   'whether the issuer was a domestic C corporation at issuance and throughout the holding period, and the evidence for it',
   'whether the issuer was a domestic C corporation at issuance and throughout the holding period, and the evidence for it', 20),
  ('01N409NARR0000000000000011', 'qsbs', 'gross_asset_test', 'Gross Assets Test',
   'the aggregate gross assets immediately before and after issuance against the $50m ceiling, and how they were measured',
   'the aggregate gross assets immediately before and after issuance against the $50m ceiling, and how they were measured', 30),
  ('01N409NARR0000000000000012', 'qsbs', 'active_business_test', 'Active Business Requirement',
   'the 80% active-business test, the trade or business conducted, and any excluded activity under 1202(e)(3)',
   'the 80% active-business test, the trade or business conducted, and any excluded activity under 1202(e)(3)', 40),
  ('01N409NARR0000000000000013', 'qsbs', 'conclusion', 'Conclusion',
   'the qualification conclusion, the holding period achieved, and the gain exclusion available',
   'the qualification conclusion, the holding period achieved, and the gain exclusion available', 80)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ── suppressions ────────────────────────────────────────────────────────────
--
-- Adding a kind's own sections is only half of making it read as its own
-- deliverable; the 409A sections it displaces have to stop being drafted, or
-- the QSBS memorandum still arrives discussing a marketability discount on
-- stock nobody valued. A disabled override is how a kind says "not this one" —
-- `enabled = false` on a `kind` row suppresses the base section outright
-- rather than falling back to it (domain/narrativePrompts.ts).
--
-- Seeded with the base library's own text, so a reviewer who decides the
-- section does belong turns it on and gets the standard wording, not a stub.

-- A §1202 memorandum is a qualification attestation, not a valuation: there is
-- no equity value to allocate, no approach to weight, and no discount to take.
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000027', 'qsbs', 'valuation_methodology', 'Valuation Methodology',
   'which approaches were used, why they fit this company, and how they were weighted',
   'which approaches were used, why they fit this company, and how they were weighted', 30, false),
  ('01N409NARR0000000000000028', 'qsbs', 'market_approach', 'Market Approach Analysis',
   'the guideline public companies selected, the selection rationale, and the multiples applied',
   'the guideline public companies selected, the selection rationale, and the multiples applied', 40, false),
  ('01N409NARR0000000000000029', 'qsbs', 'income_approach', 'Income Approach Analysis',
   'the projection assumptions and the discount-rate / WACC build-up',
   'the projection assumptions and the discount-rate / WACC build-up', 50, false),
  ('01N409NARR0000000000000030', 'qsbs', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false),
  ('01N409NARR0000000000000031', 'qsbs', 'dlom_analysis', 'Discount for Lack of Marketability',
   'the DLOM method chosen, the factors considered, and the resulting discount',
   'the DLOM method chosen, the factors considered, and the resulting discount', 70, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- A PPA allocates a purchase price across identified assets. The equity
-- allocation and the marketability discount are 409A furniture that has no
-- counterpart in ASC 805.
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000032', 'ppa', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false),
  ('01N409NARR0000000000000033', 'ppa', 'dlom_analysis', 'Discount for Lack of Marketability',
   'the DLOM method chosen, the factors considered, and the resulting discount',
   'the DLOM method chosen, the factors considered, and the resulting discount', 70, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- IFRS 2 measures the grant-date fair value of an award. There is no equity
-- value being allocated to common, and a marketability discount on the
-- instrument is not part of the measurement.
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order, enabled)
VALUES
  ('01N409NARR0000000000000034', 'ifrs2', 'allocation_methodology', 'Allocation Methodology',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares',
   'the OPM and/or PWERM rationale and the allocation of equity value to the common shares', 60, false)
ON CONFLICT (kind, section_key) DO NOTHING;

-- PPA: purchase price allocated across identified assets; no equity allocation.
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000014', 'ppa', 'executive_summary', 'Executive Summary',
   'the transaction, the acquisition date, the consideration transferred, and the resulting allocation in summary',
   'the transaction, the acquisition date, the consideration transferred, and the resulting allocation in summary', 10),
  ('01N409NARR0000000000000015', 'ppa', 'transaction_overview', 'Transaction Overview',
   'the parties, the structure, the consideration and any contingent consideration',
   'the parties, the structure, the consideration and any contingent consideration', 20),
  ('01N409NARR0000000000000016', 'ppa', 'intangible_assets', 'Identified Intangible Assets',
   'each intangible identified, the method used to value it, its useful life, and the key assumptions',
   'each intangible identified, the method used to value it, its useful life, and the key assumptions', 40),
  ('01N409NARR0000000000000017', 'ppa', 'goodwill', 'Residual Goodwill',
   'the residual goodwill and what it represents about the transaction',
   'the residual goodwill and what it represents about the transaction', 60)
ON CONFLICT (kind, section_key) DO NOTHING;

-- ASC 820 fair value measurement: the hierarchy is the point of the report.
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000018', '820', 'executive_summary', 'Executive Summary',
   'the asset or liability measured, the measurement date, the unit of account, and the concluded fair value',
   'the asset or liability measured, the measurement date, the unit of account, and the concluded fair value', 10),
  ('01N409NARR0000000000000019', '820', 'fair_value_hierarchy', 'Fair Value Hierarchy',
   'the level (1, 2 or 3) each significant input falls into under ASC 820-10-35, and why — this is the classification the auditor tests first',
   'the level (1, 2 or 3) each significant input falls into under ASC 820-10-35, and why — this is the classification the auditor tests first', 25),
  ('01N409NARR0000000000000020', '820', 'unobservable_inputs', 'Significant Unobservable Inputs',
   'each Level 3 input, its range, the weighted average, and the sensitivity of fair value to it, as ASC 820-10-50-2 requires',
   'each Level 3 input, its range, the weighted average, and the sensitivity of fair value to it, as ASC 820-10-50-2 requires', 55)
ON CONFLICT (kind, section_key) DO NOTHING;

-- Gift & estate: Revenue Ruling 59-60 is the governing authority, and the
-- discounts are the part that gets examined.
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000021', 'gifts', 'executive_summary', 'Executive Summary',
   'the interest transferred, the transfer date, the standard of value, and the concluded fair market value of the interest',
   'the interest transferred, the transfer date, the standard of value, and the concluded fair market value of the interest', 10),
  ('01N409NARR0000000000000022', 'gifts', 'revenue_ruling_factors', 'Revenue Ruling 59-60 Factors',
   'each of the eight factors in Rev. Rul. 59-60 section 4.01 addressed in turn, with the weight given to each',
   'each of the eight factors in Rev. Rul. 59-60 section 4.01 addressed in turn, with the weight given to each', 35),
  ('01N409NARR0000000000000023', 'gifts', 'dloc', 'Discount for Lack of Control',
   'the control attributes of the transferred interest, the minority discount applied, and its support — a discount in the arithmetic and not in the prose is what costs a gift valuation on examination',
   'the control attributes of the transferred interest, the minority discount applied, and its support — a discount in the arithmetic and not in the prose is what costs a gift valuation on examination', 65)
ON CONFLICT (kind, section_key) DO NOTHING;

-- IFRS 2 share-based payment: measurement basis and the vesting model.
INSERT INTO narrative_prompts (id, kind, section_key, label, guidance, default_guidance, sort_order)
VALUES
  ('01N409NARR0000000000000024', 'ifrs2', 'executive_summary', 'Executive Summary',
   'the award measured, the grant date, the measurement basis (fair value of the equity instrument granted), and the total expense',
   'the award measured, the grant date, the measurement basis (fair value of the equity instrument granted), and the total expense', 10),
  ('01N409NARR0000000000000025', 'ifrs2', 'measurement_basis', 'Measurement Basis',
   'why the award is equity-settled or cash-settled and the consequence for remeasurement under IFRS 2.30-33',
   'why the award is equity-settled or cash-settled and the consequence for remeasurement under IFRS 2.30-33', 30),
  ('01N409NARR0000000000000026', 'ifrs2', 'vesting_conditions', 'Vesting Conditions',
   'the service, performance and market conditions, and which are reflected in the grant-date fair value versus the expense attribution — IFRS 2 treats market conditions differently from the rest, and getting it the wrong way round misstates the charge',
   'the service, performance and market conditions, and which are reflected in the grant-date fair value versus the expense attribution — IFRS 2 treats market conditions differently from the rest, and getting it the wrong way round misstates the charge', 45)
ON CONFLICT (kind, section_key) DO NOTHING;
