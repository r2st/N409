/**
 * Census: every question a specialty questionnaire asks reaches its engine, or
 * is named here as one that deliberately does not.
 *
 * The bug this exists for is silent in both directions. `domain/specialty.ts`
 * assembles a questionnaire's answers into an engine request field by field, by
 * hand; the engine takes keyword arguments with defaults. So a field the
 * assembler forgets is not a type error, not a 422, not a log line — it is a
 * run that quietly used the engine's default and a deliverable that states the
 * result as a conclusion.
 *
 * That is not hypothetical. `gift_estate_valuation` accepted `annual_exclusion`,
 * `donees` and `split_gift` from the day it was written; the assembler sent none
 * of them and the questionnaire asked for none of them, so every gift & estate
 * engagement concluded a taxable gift equal to the full appraised value of the
 * interest, with "less annual exclusion — $0.00" printed above it.
 *
 * "Reaches its engine" is decided by removal rather than by name, because the
 * assembler renames as it goes (`prior_gifts_value` → `prior_taxable_gifts`) and
 * derives (`annual_revenue` × `remaining_life_years` → `revenues`). A field is
 * consumed if dropping it changes the assembled request or makes the assembly
 * refuse. Every select is walked through each of its options, because half of
 * these forms branch on one — `royalty_rate` is read only under a
 * relief-from-royalty method, and a census that tested one branch would call it
 * dead.
 */

import { describe, expect, it } from 'vitest';
import { intakeSectionsFor } from '../../src/domain/intakeKinds.js';
import {
  SPECIALTY_ENGINES,
  SPECIALTY_KINDS,
  specialtyEngineRequest,
  type SpecialtyKind,
} from '../../src/domain/specialty.js';

/**
 * The shared company section. Who is being valued is a fact about the
 * deliverable's cover and its narrative, not an engine argument — except where
 * a kind's own rules turn one into one, which is why this is subtracted rather
 * than skipped: `industry` is consumed by the QSBS form (the §1202 qualified-
 * trade test) and would show up as an error if it stopped being.
 */
const COMPANY_KEYS = [
  'legal_name',
  'state_of_incorporation',
  'incorporation_date',
  'industry',
  'employee_count',
  'business_description',
];

/**
 * Per-kind questions that are collected for the deliverable rather than for the
 * engine. Each entry is a claim that some *other* reader exists — an exhibit, an
 * HMRC form, the narrative — so adding a key here is an assertion, not a mute
 * button.
 */
const REPORT_ONLY: Record<SpecialtyKind, readonly string[]> = {
  qsbs: [],
  ppa: [
    // Cover facts for the allocation report.
    'acquirer_name',
    'closing_date',
    // "…included above": a disclosure of how much of `consideration_transferred`
    // is contingent, not an addition to it. ASC 805-30-50-1 wants the number
    // stated; the allocation must not add it twice.
    'contingent_consideration',
    // The analyst's narrative list. The priced schedule arrives as the
    // `intangibles` run input, which is what the engine allocates against.
    'intangibles_description',
  ],
  goodwill: [],
  esop: [],
  fmv: [],
  emi: HMRC_PARTICULARS(),
  csop: HMRC_PARTICULARS(),
  ip: [
    // What the asset is called and what kind of asset it is: both appear in the
    // exhibit, neither changes a discounted cash flow.
    'asset_name',
    'asset_type',
  ],
  '820': [
    // The questionnaire describes the fund; the measurement is the position
    // schedule, which is analyst work product and arrives as the `positions`
    // run input. `fair_value_measurement` takes no fund-level argument at all —
    // NAV is a property of a position (`measured_at_nav`), not of the fund.
    'fund_name',
    'fair_value_level',
    'position_count',
    'fund_nav',
    'calibrate_to_round',
    'valuation_policy',
  ],
  gifts: [
    // The prose description of what was transferred. The engine values a
    // percentage of an entity; this is what the Form 709 attachment says it was.
    'interest_transferred',
  ],
  ifrs2: [],
};

/** VAL231/VAL230 particulars — read by domain/hmrcForms.ts, not by the engine. */
function HMRC_PARTICULARS(): readonly string[] {
  return [
    'company_registration_number',
    'registered_office_address',
    'share_class',
    'shares_in_class',
    'proposed_grant_date',
    'share_restrictions',
    'previous_hmrc_agreement',
    'recent_share_transactions',
  ];
}

/**
 * Answers whose *shape* the assembler parses, where a generic string is not an
 * answer at all. Without these the assembly refuses and the census would pass by
 * never assembling anything — the failure mode a guard like this is most likely
 * to die of.
 */
const SHAPED_ANSWERS: Record<string, unknown> = {
  undiscounted_cash_flows: '120000, 130000, 90000',
};

/** Run inputs the assembler requires and no questionnaire can supply. */
const RUN_INPUTS: Partial<Record<SpecialtyKind, Record<string, unknown>>> = {
  ppa: { intangibles: [{ name: 'Technology', method: 'relief_from_royalty', params: {} }] },
  '820': { positions: [{ name: 'Position', fair_value: 1_000, level: 3 }] },
  // The gifts questionnaire asks for the interest and the discounts; the entity
  // value is the engagement's own conclusion, fed in as a run input.
  gifts: { entity_value: 10_000_000 },
};

type Answers = Record<string, unknown>;

/** A complete, plausible set of answers to a kind's questionnaire. */
function fullAnswers(kind: SpecialtyKind): Answers {
  const answers: Answers = {};
  let i = 0;
  for (const section of intakeSectionsFor(kind)) {
    for (const field of section.fields) {
      i += 1;
      if (field.key in SHAPED_ANSWERS) {
        answers[field.key] = SHAPED_ANSWERS[field.key];
        continue;
      }
      const rules = (field as { rules?: { min?: number; max?: number } }).rules ?? {};
      switch (field.type) {
        case 'number':
          // Five: inside every bound these forms declare, and large enough to
          // be a plausible year count where one is asked for.
          answers[field.key] = Math.min(rules.max ?? 5, Math.max(rules.min ?? 0, 5));
          break;
        case 'boolean':
          answers[field.key] = true;
          break;
        case 'date':
          answers[field.key] = `2026-0${(i % 9) + 1}-1${i % 9}`;
          break;
        case 'select':
          // The last option, not the first: several assemblers default an
          // unanswered select to its first value, and an answer equal to the
          // default is indistinguishable from an ignored one.
          answers[field.key] = field.options![field.options!.length - 1];
          break;
        default:
          answers[field.key] = `sentinel_${field.key}`;
      }
    }
  }
  return answers;
}

/** The same answers with each select swung to each of its options in turn. */
function branches(kind: SpecialtyKind, answers: Answers): Answers[] {
  const out: Answers[] = [answers];
  for (const section of intakeSectionsFor(kind)) {
    for (const field of section.fields) {
      if (field.type !== 'select') continue;
      for (const option of field.options!) out.push({ ...answers, [field.key]: option });
    }
  }
  return out;
}

/** Field keys whose removal changes what the engine is asked, in any branch. */
function consumedKeys(kind: SpecialtyKind): Set<string> {
  const answers = fullAnswers(kind);
  const runInputs = RUN_INPUTS[kind] ?? {};
  const consumed = new Set<string>();
  for (const branch of branches(kind, answers)) {
    // Not `expect` inside the loop by accident: an assembly that refuses a
    // complete questionnaire is the vacuity this census dies of, so it is an
    // assertion in its own right.
    const base = JSON.stringify(specialtyEngineRequest(kind, branch, runInputs));
    for (const key of Object.keys(branch)) {
      const without = { ...branch };
      delete without[key];
      let assembled: string;
      try {
        assembled = JSON.stringify(specialtyEngineRequest(kind, without, runInputs));
      } catch {
        consumed.add(key); // refused without it — read, and required
        continue;
      }
      if (assembled !== base) consumed.add(key);
    }
  }
  return consumed;
}

describe('specialty questionnaire → engine field census', () => {
  it.each(SPECIALTY_KINDS)('assembles %s from a complete questionnaire in every branch', (kind) => {
    expect(() => consumedKeys(kind)).not.toThrow();
  });

  it.each(SPECIALTY_KINDS)('sends every %s answer to its engine, or names why not', (kind) => {
    const consumed = consumedKeys(kind);
    const exempt = new Set([...COMPANY_KEYS, ...REPORT_ONLY[kind]]);
    const dropped = Object.keys(fullAnswers(kind)).filter((k) => !consumed.has(k) && !exempt.has(k));
    expect(
      dropped,
      `${kind} asks these and never sends them to ${SPECIALTY_ENGINES[kind].path}: ` +
        `wire them in domain/specialty.ts, or name them in REPORT_ONLY with the reader that does use them`,
    ).toEqual([]);
  });

  it.each(SPECIALTY_KINDS)('keeps the %s exemption list honest', (kind) => {
    const answers = fullAnswers(kind);
    const consumed = consumedKeys(kind);
    for (const key of REPORT_ONLY[kind]) {
      expect(key in answers, `${kind}: REPORT_ONLY names ${key}, which its form no longer asks`).toBe(true);
      expect(
        consumed.has(key),
        `${kind}: REPORT_ONLY still excuses ${key}, which the assembler now sends — drop the entry`,
      ).toBe(false);
    }
  });

  it('exempts the shared company section from every form that carries it', () => {
    // Subtracted rather than skipped: `industry` IS an engine argument for QSBS
    // (the §1202 qualified-trade test), and this is what says so.
    expect(consumedKeys('qsbs').has('industry')).toBe(true);
    expect(consumedKeys('ifrs2').has('industry')).toBe(false);
  });
});
