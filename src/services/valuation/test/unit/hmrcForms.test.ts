import { describe, expect, it } from 'vitest';
import {
  buildHmrcForm,
  FORM_FOR_SCHEME,
  schemeForKind,
  type HmrcForm,
  type HmrcFormInput,
} from '../../src/domain/hmrcForms.js';
import { hmrcFormExhibit } from '../../src/domain/specialtyExhibits.js';
import { intakeSectionsFor } from '../../src/domain/intakeKinds.js';

/** A fully-answered EMI engagement — the shape routes/specialty.ts records. */
const EMI: HmrcFormInput = {
  kind: 'emi',
  currency: 'GBP',
  companyName: 'Vivoo Ltd',
  profile: {
    legal_name: 'Vivoo Limited',
    address_line1: '1 Example Street',
    city: 'London',
    postal_code: 'EC1A 1AA',
    country: 'United Kingdom',
  },
  answers: {
    company_registration_number: '09876543',
    registered_office_address: '2 Registered Row, London, EC2A 2BB',
    share_class: 'Ordinary shares of £0.0001 each',
    proposed_grant_date: '2026-09-01',
    share_restrictions: 'Good/bad leaver provisions; transfer restricted under the articles.',
  },
  specialty: {
    pro_rata_per_share: 2.5,
    minority_discount: 0.1,
    restriction_discount: 0.2,
    umv_per_share: 2.25,
    amv_per_share: 1.8,
    qualification: {
      scheme: 'emi',
      qualifies: true,
      checks: {
        individual_limit: { passed: true, detail: '£225,000 UMV in the 3-year window' },
        company_limit: { passed: true, detail: '£900,000 unexercised UMV' },
      },
    },
  },
  params: {
    total_shares: 1_000_000,
    options_granted: 100_000,
    gross_assets: 4_000_000,
    employee_count: 42,
    is_independent: true,
    has_qualifying_trade: true,
    works_25_hours_or_75_pct: true,
  },
};

const CSOP: HmrcFormInput = {
  ...EMI,
  kind: 'csop',
  specialty: {
    ...EMI.specialty,
    qualification: {
      scheme: 'csop',
      qualifies: false,
      checks: {
        individual_limit: { passed: true, detail: '£45,000 UMV against the £60,000 limit' },
        exercise_price_not_below_umv: {
          passed: false,
          detail: 'exercise price £2.0000 vs UMV £2.2500 at grant',
        },
      },
    },
  },
  params: { total_shares: 1_000_000, options_granted: 20_000, exercise_price: 2.0 },
};

const fields = (form: HmrcForm) => form.sections.flatMap((s) => s.fields);
const byKey = (form: HmrcForm, key: string) => fields(form).find((f) => f.key === key);

describe('form selection', () => {
  it('pairs EMI with VAL231 and CSOP with VAL230, not the reverse', () => {
    // The single most damaging thing this module could get wrong.
    expect(FORM_FOR_SCHEME.emi).toBe('VAL231');
    expect(FORM_FOR_SCHEME.csop).toBe('VAL230');
    expect(buildHmrcForm(EMI)!.code).toBe('VAL231');
    expect(buildHmrcForm(CSOP)!.code).toBe('VAL230');
  });

  it('has no form for any other kind', () => {
    for (const kind of ['409a', 'fmv', '718', '820', 'qsbs', 'ppa', 'esop', 'ip']) {
      expect(schemeForKind(kind)).toBeNull();
      expect(buildHmrcForm({ ...EMI, kind })).toBeNull();
    }
  });
});

describe('VAL231 (EMI)', () => {
  const form = buildHmrcForm(EMI)!;

  it('is complete when every required answer is present', () => {
    expect(form.missing_required).toEqual([]);
    expect(form.complete).toBe(true);
  });

  it('states UMV and AMV separately and correctly', () => {
    expect(byKey(form, 'umv_per_share')!.value).toBe('£2.2500');
    expect(byKey(form, 'amv_per_share')!.value).toBe('£1.8000');
    // Both required: the limits are tested on UMV, the grant price set from AMV.
    expect(byKey(form, 'umv_per_share')!.required).toBe(true);
    expect(byKey(form, 'amv_per_share')!.required).toBe(true);
  });

  it('carries the Schedule 5 conditions the engine tested', () => {
    expect(byKey(form, 'gross_assets')!.value).toBe('£4,000,000');
    expect(byKey(form, 'employee_count')!.value).toBe('42');
    expect(byKey(form, 'is_independent')!.value).toBe('Yes');
    expect(byKey(form, 'individual_limit')!.value).toContain('£225,000');
    expect(byKey(form, 'qualifies')!.value).toBe('Yes');
  });

  it('prefers the supplied registered office over the profile address', () => {
    // The profile holds a trading address; the form asks for the registered
    // office and they routinely differ.
    const f = byKey(form, 'registered_office_address')!;
    expect(f.value).toBe('2 Registered Row, London, EC2A 2BB');
    expect(f.note).toBeUndefined();
  });

  it('falls back to the profile address but flags that it did', () => {
    const f = byKey(buildHmrcForm({ ...EMI, answers: {} })!, 'registered_office_address')!;
    expect(f.value).toBe('1 Example Street, London, EC1A 1AA, United Kingdom');
    expect(f.note).toMatch(/confirm this is the registered office/i);
  });

  it('reads the grant size from the engine payload', () => {
    expect(byKey(form, 'options_granted')!.value).toBe('100,000');
    expect(byKey(form, 'shares_in_issue')!.value).toBe('1,000,000');
  });

  it('lets a share class narrower than the issued capital override the denominator', () => {
    const f = buildHmrcForm({
      ...EMI,
      answers: { ...EMI.answers, shares_in_class: 250_000 },
    })!;
    expect(byKey(f, 'shares_in_issue')!.value).toBe('250,000');
  });
});

describe('VAL230 (CSOP)', () => {
  const form = buildHmrcForm(CSOP)!;

  it('requires the exercise price and reports the Schedule 4 tests', () => {
    expect(byKey(form, 'exercise_price')!.value).toBe('£2.0000');
    expect(byKey(form, 'exercise_price')!.required).toBe(true);
    expect(byKey(form, 'exercise_price_not_below_umv')!.value).toContain('vs UMV');
    expect(byKey(form, 'qualifies')!.value).toBe('No');
  });

  it('does not require AMV — the CSOP tests all run on UMV', () => {
    expect(byKey(form, 'umv_per_share')!.required).toBe(true);
    expect(byKey(form, 'amv_per_share')!.required).toBe(false);
  });

  it('has no Schedule 5 fields', () => {
    expect(byKey(form, 'gross_assets')).toBeUndefined();
    expect(byKey(form, 'has_qualifying_trade')).toBeUndefined();
  });
});

describe('incomplete packs', () => {
  it('reports every missing required field rather than dropping it', () => {
    // HMRC rejects an incomplete form. Silence here reads as "nothing to
    // declare" and the rejection arrives weeks later.
    const form = buildHmrcForm({ ...EMI, answers: null, profile: null })!;
    expect(form.complete).toBe(false);
    expect(form.missing_required).toEqual(
      expect.arrayContaining([
        'Company registration number',
        'Registered office address',
        'Class of shares to be placed under option',
        'Date of the proposed grant',
        'Restrictions attaching to the shares',
      ]),
    );
    // Present but empty, not absent from the pack.
    expect(byKey(form, 'company_registration_number')!.value).toBeNull();
  });

  it('treats a whitespace-only answer as unanswered', () => {
    const form = buildHmrcForm({
      ...EMI,
      answers: { ...EMI.answers, company_registration_number: '   ' },
    })!;
    expect(form.complete).toBe(false);
    expect(byKey(form, 'company_registration_number')!.value).toBeNull();
  });

  it('rejects a malformed grant date instead of printing it', () => {
    const form = buildHmrcForm({ ...EMI, answers: { ...EMI.answers, proposed_grant_date: 'soon' } })!;
    expect(byKey(form, 'proposed_grant_date')!.value).toBeNull();
  });

  it('survives an engagement with no calculation at all', () => {
    const form = buildHmrcForm({ ...EMI, specialty: null, params: null })!;
    expect(form.complete).toBe(false);
    expect(byKey(form, 'umv_per_share')!.value).toBeNull();
    expect(byKey(form, 'qualifies')!.value).toBeNull();
  });

  it('still names the company from the engagement when nothing else is known', () => {
    const form = buildHmrcForm({
      kind: 'emi',
      currency: 'GBP',
      companyName: 'Vivoo Ltd',
    })!;
    expect(byKey(form, 'company_name')!.value).toBe('Vivoo Ltd');
  });
});

describe('the rendered appendix', () => {
  it('disclaims being HMRC’s own form', () => {
    // The pack carries every figure the real form asks for, which is exactly
    // why it must not read as the form itself.
    const html = hmrcFormExhibit(buildHmrcForm(EMI)!).html;
    expect(html).toContain('data pack, not the form');
    expect(hmrcFormExhibit(buildHmrcForm(EMI)!).heading).toContain('VAL231');
  });

  it('prints a missing required field as words, never as an empty cell', () => {
    const html = hmrcFormExhibit(buildHmrcForm({ ...EMI, answers: null, profile: null })!).html;
    expect(html).toContain('Not supplied — required');
    expect(html).toContain('This pack is not yet complete');
    expect(html).toContain('Company registration number');
  });

  it('says so plainly when nothing is outstanding', () => {
    const html = hmrcFormExhibit(buildHmrcForm(EMI)!).html;
    expect(html).toContain('Every field this form requires has been answered');
    expect(html).not.toContain('Not supplied — required');
  });

  it('escapes a company-supplied answer instead of letting it close a cell', () => {
    const html = hmrcFormExhibit(
      buildHmrcForm({
        ...EMI,
        answers: { ...EMI.answers, share_class: 'Ordinary <script>alert(1)</script> A & B' },
      })!,
    ).html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B');
  });
});

describe('intake collects what the form needs', () => {
  it.each(['emi', 'csop'] as const)('%s asks for every required form field', (kind) => {
    // The form's required fields must be answerable. A field HMRC demands that
    // the questionnaire never asks for is a pack that can never be completed.
    const asked = new Set(intakeSectionsFor(kind).flatMap((s) => s.fields.map((f) => f.key)));
    for (const key of [
      'company_registration_number',
      'registered_office_address',
      'share_class',
      'proposed_grant_date',
      'share_restrictions',
    ]) {
      expect(asked.has(key), `${kind} intake is missing ${key}`).toBe(true);
    }
  });

  it('allows a future grant date — the whole point of agreeing a value in advance', () => {
    const section = intakeSectionsFor('emi').find((s) => s.key === 'hmrc_request');
    const field = section?.fields.find((f) => f.key === 'proposed_grant_date');
    expect(field?.rules?.notFuture).toBeUndefined();
  });
});
