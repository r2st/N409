import { describe, expect, it } from 'vitest';
import { intakeCrossRulesFor, intakeFieldKeysFor, intakeSectionsFor } from '../../src/domain/intakeKinds.js';
import {
  computeCompletion,
  INTAKE_CROSS_RULES,
  INTAKE_SECTIONS,
  narrowIntakeAnswers,
  validateIntake,
} from '../../src/domain/intake.js';
import { VALUATION_KINDS, type ValuationKind } from '../../src/domain/valuation.js';

/** Kinds that carry their own questionnaire rather than the 409A fallback. */
const DEDICATED: ValuationKind[] = [
  '409a',
  'qsbs',
  '718',
  '820',
  'csop',
  'emi',
  'fmv',
  'ifrs2',
  'gifts',
  'ppa',
  'goodwill',
  'esop',
  'ip',
  'fund',
];

describe('intakeSectionsFor', () => {
  it('serves the 409A questionnaire for 409a and for kinds with no dedicated form', () => {
    expect(intakeSectionsFor('409a')).toBe(INTAKE_SECTIONS);
    expect(intakeSectionsFor('debt')).toBe(INTAKE_SECTIONS);
    expect(intakeCrossRulesFor('debt')).toBe(INTAKE_CROSS_RULES);
  });

  it('serves a dedicated questionnaire for every specialty kind', () => {
    for (const kind of DEDICATED.filter((k) => k !== '409a')) {
      const sections = intakeSectionsFor(kind);
      expect(sections, kind).not.toBe(INTAKE_SECTIONS);
      expect(sections.length, kind).toBeGreaterThanOrEqual(2);
    }
  });

  it('opens every questionnaire with the shared company section', () => {
    for (const kind of DEDICATED) {
      expect(intakeSectionsFor(kind)[0]!.key, kind).toBe('company');
    }
  });

  it('has unique field keys within each kind and required fields in every kind section', () => {
    for (const kind of VALUATION_KINDS) {
      const sections = intakeSectionsFor(kind);
      const keys = sections.flatMap((s) => s.fields.map((f) => f.key));
      expect(new Set(keys).size, kind).toBe(keys.length);
      const required = sections.flatMap((s) => s.fields).filter((f) => f.required);
      expect(required.length, kind).toBeGreaterThan(0);
    }
  });

  it('gives every select field options and every cross rule fields its form asks', () => {
    for (const kind of VALUATION_KINDS) {
      const keys = intakeFieldKeysFor(kind);
      for (const section of intakeSectionsFor(kind)) {
        for (const field of section.fields) {
          if (field.type === 'select') {
            expect(field.options?.length ?? 0, `${kind}.${field.key}`).toBeGreaterThan(0);
          }
        }
      }
      for (const rule of intakeCrossRulesFor(kind)) {
        expect(keys.has(rule.field), `${kind}:${rule.key} anchors to a known field`).toBe(true);
        expect(keys.has(rule.left), `${kind}:${rule.key} left operand`).toBe(true);
        if (typeof rule.right === 'string') {
          expect(keys.has(rule.right), `${kind}:${rule.key} right operand`).toBe(true);
        }
        if (rule.when) expect(keys.has(rule.when.field), `${kind}:${rule.key} when field`).toBe(true);
      }
    }
  });
});

describe('kind-aware completion and narrowing', () => {
  it('judges completion against the kind form, not the 409A form', () => {
    const sections = intakeSectionsFor('csop');
    const empty = computeCompletion({}, sections);
    expect(empty.ready).toBe(false);
    expect(empty.sections.map((s) => s.key)).toEqual([
      'company',
      'share_value',
      // The VAL230 particulars. A CSOP engagement is not complete without them:
      // the deliverable includes the HMRC agreement request, and HMRC will not
      // process one with the registered number or the share class blank.
      'hmrc_request',
      'csop_grant',
    ]);

    const answers = {
      legal_name: 'Grantco Ltd',
      state_of_incorporation: 'England',
      incorporation_date: '2019-04-01',
      industry: 'software',
      business_description: 'B2B SaaS.',
      equity_value: 5_000_000,
      total_shares: 1_000_000,
      options_granted: 10_000,
      exercise_price: 5,
      company_registration_number: '09876543',
      registered_office_address: '2 Registered Row, London, EC2A 2BB',
      share_class: 'Ordinary shares of £0.0001 each',
      proposed_grant_date: '2026-11-01',
      share_restrictions: 'Good/bad leaver provisions.',
    };
    expect(computeCompletion(answers, sections).ready).toBe(true);
    // The same answers judged against the 409A form are incomplete — it wants
    // cap-table and legal facts the CSOP form never asks.
    expect(computeCompletion(answers).ready).toBe(false);
  });

  it('narrows answers to the kind form’s keys', () => {
    const keys = intakeFieldKeysFor('qsbs');
    const clean = narrowIntakeAnswers(
      { entity_type: 'c_corp', total_shares_outstanding: 100, junk: 'x' },
      keys,
    );
    expect(clean).toEqual({ entity_type: 'c_corp' });
  });

  it('validates kind fields with the shared evaluators', () => {
    const sections = intakeSectionsFor('qsbs');
    const crossRules = intakeCrossRulesFor('qsbs');
    const issues = validateIntake(
      {
        active_business_asset_pct: 1.4,
        gross_assets_before_issuance: 40_000_000,
        gross_assets_after_issuance: 30_000_000,
      },
      { sections, crossRules },
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ field: 'active_business_asset_pct', severity: 'error' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ field: 'gross_assets_after_issuance', severity: 'warning' }),
    );
  });

  it('warns on an in-the-money 718 grant and on EMI limits', () => {
    const emi = validateIntake(
      { gross_assets: 31_000_000, fte_employee_count: 260 },
      { sections: intakeSectionsFor('emi'), crossRules: intakeCrossRulesFor('emi') },
    );
    expect(emi.filter((i) => i.severity === 'warning')).toHaveLength(2);

    const asc718 = validateIntake(
      { exercise_price: 1, underlying_fmv: 2 },
      { sections: intakeSectionsFor('718'), crossRules: intakeCrossRulesFor('718') },
    );
    expect(asc718).toContainEqual(expect.objectContaining({ field: 'exercise_price', severity: 'warning' }));
  });
});
