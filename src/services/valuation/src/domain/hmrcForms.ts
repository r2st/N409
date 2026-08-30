/**
 * HMRC share-valuation agreement forms — VAL231 (EMI) and VAL230 (CSOP).
 *
 * A UK option-scheme engagement does not end with a number. Before options are
 * granted, the company asks HMRC's Shares and Assets Valuation team to *agree*
 * the value, on VAL231 for an Enterprise Management Incentives grant and
 * VAL230 for a Company Share Option Plan one. Until this module existed the
 * EMI and CSOP deliverables concluded UMV and AMV and stopped there, leaving
 * the client to transcribe the figures onto a form by hand — the step where a
 * transposed decimal costs the plan its tax treatment.
 *
 * What this produces is a completed **data pack**: every field the form asks
 * for, paired with the value this engagement concluded or collected, ready to
 * transcribe or attach as supporting documentation. It is deliberately not a
 * facsimile of HMRC's own PDF — that template is theirs to publish and ours to
 * fill in, and a lookalike carrying our layout is exactly the artefact a
 * client would submit by mistake. The rendered appendix says so on its face.
 *
 * The load-bearing decision here is that a missing answer is *reported*, never
 * invented or quietly omitted. HMRC rejects an incomplete form, and a pack
 * that silently skips the registered number reads as complete until it comes
 * back. `missing_required` is the list an analyst works through before the
 * form goes out, and `complete` is false until it is empty.
 */

import { isIsoCalendarDate } from '@n409/shared';
import type { ValuationKind } from './valuation.js';
import { numberFormat } from './numberFormat.js';

export type HmrcScheme = 'emi' | 'csop';
export type HmrcFormCode = 'VAL230' | 'VAL231';

/** Which form a scheme is agreed on. EMI is 231, CSOP is 230 — not the other way. */
export const FORM_FOR_SCHEME: Record<HmrcScheme, HmrcFormCode> = {
  emi: 'VAL231',
  csop: 'VAL230',
};

export const FORM_TITLE: Record<HmrcFormCode, string> = {
  VAL231: 'VAL231 — Enterprise Management Incentives: request for a share valuation',
  VAL230: 'VAL230 — Company Share Option Plan: request for a share valuation',
};

export interface HmrcFormField {
  key: string;
  label: string;
  /** The answer, formatted for the form. `null` means we do not have it. */
  value: string | null;
  /** HMRC will not process the form with this blank. */
  required: boolean;
  /** Where the value came from, or what the analyst must do about its absence. */
  note?: string;
}

export interface HmrcFormSection {
  title: string;
  fields: HmrcFormField[];
}

export interface HmrcForm {
  scheme: HmrcScheme;
  code: HmrcFormCode;
  title: string;
  sections: HmrcFormSection[];
  /** Labels of required fields with no answer. Empty ⇒ ready to submit. */
  missing_required: string[];
  complete: boolean;
}

/** The kinds that have an HMRC form at all. */
export function schemeForKind(kind: ValuationKind | string): HmrcScheme | null {
  return kind === 'emi' || kind === 'csop' ? kind : null;
}

// ── value coercion ───────────────────────────────────────────────────────────

type Answers = Record<string, unknown>;

/**
 * A trimmed non-empty string, or null.
 *
 * Whitespace-only counts as absent: a client who tabbed through a textarea has
 * not answered it, and a form field containing one space is blank to HMRC.
 */
function str(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Money on these forms is GBP: EMI and CSOP are UK statutory schemes and the
 * limits they are tested against are denominated in sterling. The currency is
 * still taken from the engagement rather than hardcoded, because an engagement
 * recorded in another currency is a data problem an analyst needs to see on
 * the form rather than a rounding difference hidden behind a £ sign.
 */
function money(value: unknown, currency: string, digits = 4): string | null {
  const n = num(value);
  if (n === null) return null;
  return numberFormat('en-GB', {
    style: 'currency',
    currency: currency || 'GBP',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

function count(value: unknown): string | null {
  const n = num(value);
  return n === null ? null : numberFormat('en-GB').format(n);
}

function yesNo(value: unknown): string | null {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return null;
}

/**
 * A `date` answer as the form wants it, guarding against a junk string.
 *
 * Against the calendar rather than against the shape. These strings are printed
 * onto a statutory HMRC return, and `2026-02-31` matches `\d{4}-\d{2}-\d{2}`
 * without being a day — so the shape check let the one value the guard exists
 * to catch through to the form.
 */
function date(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const iso = s.slice(0, 10);
  return isIsoCalendarDate(iso) ? iso : null;
}

// ── inputs ───────────────────────────────────────────────────────────────────

export interface HmrcFormInput {
  kind: ValuationKind | string;
  /** Engagement currency. UK schemes are GBP; see `money` above. */
  currency: string;
  /** Falls back to the engagement's company_name when no profile is stored. */
  companyName: string;
  /** The company_profiles row, when one exists. */
  profile?: {
    legal_name?: string | null;
    address_line1?: string | null;
    address_line2?: string | null;
    city?: string | null;
    region?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
  /** The submitted questionnaire's answers — carries the HMRC_REQUEST_SECTION fields. */
  answers?: Answers | null;
  /** `results.specialty` from the latest succeeded emi/csop run. */
  specialty?: Answers | null;
  /** `inputs.params` from that run — the grant facts the engine was given. */
  params?: Answers | null;
}

/**
 * The registered office, preferring what the client typed on the HMRC section.
 *
 * The company profile's address is the trading address an analyst captured; the
 * form asks for the *registered office*, which is often a formation agent's and
 * frequently differs. The profile is a fallback, not the answer, and the note
 * says which one is on the page so a reviewer can tell them apart.
 */
function registeredOffice(input: HmrcFormInput): { value: string | null; note?: string } {
  const supplied = str(input.answers?.registered_office_address);
  if (supplied) return { value: supplied };
  const p = input.profile;
  if (!p) return { value: null };
  const parts = [p.address_line1, p.address_line2, p.city, p.region, p.postal_code, p.country]
    .map((v) => str(v))
    .filter((v): v is string => v !== null);
  if (parts.length === 0) return { value: null };
  return {
    value: parts.join(', '),
    note: 'Taken from the company profile — confirm this is the registered office, not the trading address.',
  };
}

function field(
  key: string,
  label: string,
  value: string | null,
  required: boolean,
  note?: string,
): HmrcFormField {
  return { key, label, value, required, ...(note ? { note } : {}) };
}

// ── shared blocks ────────────────────────────────────────────────────────────

function companySection(input: HmrcFormInput): HmrcFormSection {
  const office = registeredOffice(input);
  return {
    title: 'Company',
    fields: [
      field(
        'company_name',
        'Full name of the company',
        str(input.answers?.legal_name) ?? str(input.profile?.legal_name) ?? str(input.companyName),
        true,
      ),
      field(
        'company_registration_number',
        'Company registration number',
        str(input.answers?.company_registration_number),
        true,
      ),
      field('registered_office_address', 'Registered office address', office.value, true, office.note),
    ],
  };
}

function sharesSection(input: HmrcFormInput): HmrcFormSection {
  const params = input.params ?? {};
  const answers = input.answers ?? {};
  // The engine's total_shares is the denominator the per-share value was
  // divided by, so it is the figure the form's value column is consistent
  // with. `shares_in_class` only differs when the class under option is not
  // the whole issued capital, and then it is the client's answer that governs.
  const inIssue = count(answers.shares_in_class) ?? count(params.total_shares);
  return {
    title: 'Shares',
    fields: [
      field('share_class', 'Class of shares to be placed under option', str(answers.share_class), true),
      field(
        'shares_in_issue',
        'Shares of that class in issue',
        inIssue,
        true,
        str(answers.shares_in_class)
          ? undefined
          : 'Total shares in issue, as used as the denominator in the valuation.',
      ),
      field(
        'options_granted',
        'Number of shares to be placed under option',
        count(params.options_granted),
        true,
      ),
      field('proposed_grant_date', 'Date of the proposed grant', date(answers.proposed_grant_date), true),
      field(
        'share_restrictions',
        'Restrictions attaching to the shares',
        str(answers.share_restrictions),
        true,
        'The restrictions priced into the difference between UMV and AMV.',
      ),
    ],
  };
}

/**
 * How the figures were reached.
 *
 * HMRC asks for the basis, not just the answer, and the discounts are the part
 * they interrogate. Stating the restriction discount as its own line — rather
 * than only as the gap between two per-share figures — is what lets a reviewer
 * check the AMV without recomputing it.
 */
function basisSection(input: HmrcFormInput): HmrcFormSection {
  const s = input.specialty ?? {};
  const pct = (v: unknown): string | null => {
    const n = num(v);
    return n === null ? null : `${(n * 100).toFixed(2)}%`;
  };
  return {
    title: 'Basis of valuation',
    fields: [
      field(
        'pro_rata_per_share',
        'Pro-rata value per share before discounts',
        money(s.pro_rata_per_share, input.currency),
        false,
      ),
      field('minority_discount', 'Minority discount applied', pct(s.minority_discount), false),
      field(
        'restriction_discount',
        'Discount for restrictions (UMV → AMV)',
        pct(s.restriction_discount),
        false,
      ),
      field(
        'previous_hmrc_agreement',
        'Previous HMRC valuation agreement',
        str(input.answers?.previous_hmrc_agreement) ?? 'None',
        false,
      ),
      field(
        'recent_share_transactions',
        'Recent transactions in the company’s shares',
        str(input.answers?.recent_share_transactions) ?? 'None reported',
        false,
      ),
    ],
  };
}

// ── VAL231 (EMI) ─────────────────────────────────────────────────────────────

function val231Sections(input: HmrcFormInput): HmrcFormSection[] {
  const s = input.specialty ?? {};
  const params = input.params ?? {};
  const qualification = (s.qualification ?? {}) as Answers;
  const checks = (qualification.checks ?? {}) as Answers;
  const checkDetail = (name: string): string | null => {
    const c = checks[name] as { detail?: unknown } | undefined;
    return c ? str(c.detail) : null;
  };

  return [
    companySection(input),
    sharesSection(input),
    {
      // Both figures, always, and labelled in full. UMV and AMV are three
      // letters apart and the scheme limits are tested on UMV while the grant
      // price is set from AMV; a form that swaps them agrees the wrong number.
      title: 'Values proposed for agreement',
      fields: [
        field(
          'umv_per_share',
          'Unrestricted market value (UMV) per share',
          money(s.umv_per_share, input.currency),
          true,
          'The figure the Schedule 5 limits are tested against.',
        ),
        field(
          'amv_per_share',
          'Actual market value (AMV) per share',
          money(s.amv_per_share, input.currency),
          true,
          'UMV less the discount for restrictions.',
        ),
      ],
    },
    {
      title: 'Schedule 5 qualifying conditions',
      fields: [
        field(
          'gross_assets',
          'Gross assets of the company',
          money(params.gross_assets, input.currency, 0),
          true,
        ),
        field(
          'employee_count',
          'Full-time-equivalent employees',
          count(params.employee_count ?? params.fte_employee_count),
          true,
        ),
        field('is_independent', 'Is the company independent?', yesNo(params.is_independent), true),
        field(
          'has_qualifying_trade',
          'Does the company carry on a qualifying trade?',
          yesNo(params.has_qualifying_trade),
          true,
        ),
        field(
          'working_time',
          'Does the employee meet the working-time requirement?',
          yesNo(params.works_25_hours_or_75_pct),
          true,
        ),
        field(
          'individual_limit',
          'Individual £250,000 limit',
          checkDetail('individual_limit'),
          false,
          'UMV of EMI and CSOP options held, over the rolling three-year window.',
        ),
        field(
          'company_limit',
          'Company £3,000,000 limit',
          checkDetail('company_limit'),
          false,
          'UMV of all unexercised EMI options company-wide.',
        ),
        field(
          'qualifies',
          'Does the grant satisfy every condition tested?',
          yesNo(qualification.qualifies),
          false,
        ),
      ],
    },
    basisSection(input),
  ];
}

// ── VAL230 (CSOP) ────────────────────────────────────────────────────────────

function val230Sections(input: HmrcFormInput): HmrcFormSection[] {
  const s = input.specialty ?? {};
  const params = input.params ?? {};
  const qualification = (s.qualification ?? {}) as Answers;
  const checks = (qualification.checks ?? {}) as Answers;
  const checkDetail = (name: string): string | null => {
    const c = checks[name] as { detail?: unknown } | undefined;
    return c ? str(c.detail) : null;
  };

  return [
    companySection(input),
    sharesSection(input),
    {
      title: 'Values proposed for agreement',
      fields: [
        field(
          'umv_per_share',
          'Market value (UMV) per share at grant',
          money(s.umv_per_share, input.currency),
          true,
          'Schedule 4 requires the exercise price to be no less than this.',
        ),
        field(
          'amv_per_share',
          'Actual market value (AMV) per share',
          money(s.amv_per_share, input.currency),
          false,
          'Stated for completeness; the CSOP limit and the exercise-price test both run on UMV.',
        ),
        field(
          'exercise_price',
          'Proposed exercise price per share',
          money(params.exercise_price, input.currency),
          true,
        ),
      ],
    },
    {
      title: 'Schedule 4 conditions',
      fields: [
        field(
          'individual_limit',
          'Individual £60,000 limit',
          checkDetail('individual_limit'),
          false,
          'UMV at grant of CSOP options held.',
        ),
        field(
          'exercise_price_not_below_umv',
          'Exercise price not below market value at grant',
          checkDetail('exercise_price_not_below_umv'),
          false,
        ),
        field(
          'qualifies',
          'Does the grant satisfy every condition tested?',
          yesNo(qualification.qualifies),
          false,
        ),
      ],
    },
    basisSection(input),
  ];
}

// ── assembly ─────────────────────────────────────────────────────────────────

/**
 * Build the form pack for an EMI or CSOP engagement.
 *
 * Returns null for every other kind rather than an empty form: there is no
 * VAL230 for a 409A, and a caller that renders whatever this returns should
 * render nothing at all.
 */
export function buildHmrcForm(input: HmrcFormInput): HmrcForm | null {
  const scheme = schemeForKind(input.kind);
  if (!scheme) return null;
  const code = FORM_FOR_SCHEME[scheme];
  const sections = scheme === 'emi' ? val231Sections(input) : val230Sections(input);
  const missing = sections
    .flatMap((s) => s.fields)
    .filter((f) => f.required && f.value === null)
    .map((f) => f.label);
  return {
    scheme,
    code,
    title: FORM_TITLE[code],
    sections,
    missing_required: missing,
    complete: missing.length === 0,
  };
}
