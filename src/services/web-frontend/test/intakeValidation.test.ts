import { describe, expect, it } from 'vitest';
import {
  hasBlockingIssues,
  issuesByField,
  isValidIsoDate,
  validateIntake,
  type IntakeCrossRule,
  type IntakeSection,
} from '../src/lib/intakeValidation';

/**
 * The browser half of intake validation.
 *
 * The rules are not defined here — they arrive from the valuation service
 * inside the schema payload. So these fixtures are shaped like what the wire
 * actually delivers, and the assertions are the messages the server would
 * produce for the same answers: if the two evaluators disagree, a client is
 * told their form is fine and then has it rejected on submit.
 */

const SECTIONS: IntakeSection[] = [
  {
    key: 'company',
    title: 'Company information',
    description: '',
    fields: [
      { key: 'legal_name', label: 'Legal company name', type: 'text', required: true },
      {
        key: 'incorporation_date',
        label: 'Date of incorporation',
        type: 'date',
        required: true,
        rules: { notFuture: true, minDate: '1900-01-01' },
      },
      {
        key: 'employee_count',
        label: 'Number of employees',
        type: 'number',
        required: false,
        rules: { min: 0, integer: true },
      },
    ],
  },
  {
    key: 'financials',
    title: 'Financials',
    description: '',
    fields: [
      {
        key: 'revenue_status',
        label: 'Revenue stage',
        type: 'select',
        required: true,
        options: ['pre_revenue', 'post_revenue'],
      },
      {
        key: 'last_fy_revenue',
        label: 'Last fiscal-year revenue',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      { key: 'monthly_burn', label: 'Monthly net burn', type: 'number', required: false, rules: { min: 0 } },
      { key: 'cash_on_hand', label: 'Cash on hand', type: 'number', required: false, rules: { min: 0 } },
    ],
  },
  {
    key: 'legal',
    title: 'Legal & governance',
    description: '',
    fields: [
      {
        key: 'business_description',
        label: 'Business description',
        type: 'textarea',
        required: true,
        rules: { maxLength: 20 },
      },
      {
        key: 'has_articles',
        label: 'Articles of incorporation available?',
        type: 'boolean',
        required: true,
      },
    ],
  },
];

const CROSS_RULES: IntakeCrossRule[] = [
  {
    key: 'burn_exceeds_cash',
    field: 'monthly_burn',
    severity: 'warning',
    left: 'monthly_burn',
    op: 'gt',
    right: 'cash_on_hand',
    message: 'Monthly burn is greater than cash on hand — that is under one month of runway.',
  },
  {
    key: 'pre_revenue_with_revenue',
    field: 'last_fy_revenue',
    severity: 'warning',
    left: 'last_fy_revenue',
    op: 'gt',
    right: 0,
    when: { field: 'revenue_status', equals: ['pre_revenue'] },
    message: 'The company is marked pre-revenue but reports last fiscal-year revenue above zero.',
  },
];

const TODAY = new Date('2026-08-01T00:00:00Z');
const check = (answers: Record<string, unknown>) =>
  validateIntake(SECTIONS, CROSS_RULES, answers, { today: TODAY });

describe('isValidIsoDate', () => {
  it('rejects a day the month does not have', () => {
    expect(isValidIsoDate('2023-02-30')).toBe(false);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
  });
});

describe('validateIntake', () => {
  it('says nothing about a blank form', () => {
    expect(check({})).toEqual([]);
    expect(check({ legal_name: '   ', last_fy_revenue: null })).toEqual([]);
  });

  it('refuses negative revenue in the same words the server uses', () => {
    expect(check({ last_fy_revenue: -100 })).toEqual([
      {
        field: 'last_fy_revenue',
        severity: 'error',
        message: 'Last fiscal-year revenue cannot be negative.',
      },
    ]);
  });

  it('refuses an impossible date', () => {
    expect(check({ incorporation_date: '2023-02-30' })).toEqual([
      {
        field: 'incorporation_date',
        severity: 'error',
        message: 'Date of incorporation must be a valid date (YYYY-MM-DD).',
      },
    ]);
  });

  it('refuses a future date and a mistyped century', () => {
    expect(check({ incorporation_date: '2027-01-01' })[0]?.message).toBe(
      'Date of incorporation cannot be in the future.',
    );
    expect(check({ incorporation_date: '0202-05-14' })[0]?.message).toBe(
      'Date of incorporation looks mistyped — it is before 1900-01-01.',
    );
  });

  it('requires whole headcounts', () => {
    expect(check({ employee_count: 4.5 })[0]?.message).toBe('Number of employees must be a whole number.');
  });

  it('warns without blocking when burn outruns cash', () => {
    const issues = check({ cash_on_hand: 50_000, monthly_burn: 80_000 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it('honours a rule guard', () => {
    expect(check({ revenue_status: 'pre_revenue', last_fy_revenue: 10_000 })).toHaveLength(1);
    expect(check({ revenue_status: 'post_revenue', last_fy_revenue: 10_000 })).toEqual([]);
  });

  it('skips a cross rule until both operands are answered', () => {
    expect(check({ monthly_burn: 80_000 })).toEqual([]);
  });

  it('reports issues in schema order so the list reads like the form', () => {
    const issues = check({ employee_count: -1, last_fy_revenue: -1 });
    expect(issues.map((i) => i.field)).toEqual(['employee_count', 'last_fy_revenue']);
  });

  /**
   * These four mirror `domain/intake.ts` exactly. The server's option check
   * used to be skipped rather than failed when the answer was not a string, and
   * text answers had no shape or length rule at all — so both evaluators are
   * pinned to the same messages here, because the whole point of shipping the
   * rules on the wire is that the browser says what the submit will say.
   */
  it('fails a non-string choice rather than skipping the check', () => {
    expect(check({ revenue_status: 7 })).toEqual([
      {
        field: 'revenue_status',
        severity: 'error',
        message: 'Revenue stage must be one of the offered choices.',
      },
    ]);
  });

  it('refuses a non-string answer to a text field', () => {
    expect(check({ business_description: { a: 1 } })).toEqual([
      { field: 'business_description', severity: 'error', message: 'Business description must be text.' },
    ]);
  });

  it('refuses a non-boolean answer to a yes/no field', () => {
    expect(check({ has_articles: 'yes' })).toEqual([
      {
        field: 'has_articles',
        severity: 'error',
        message: 'Articles of incorporation available? must be answered yes or no.',
      },
    ]);
    expect(check({ has_articles: false })).toEqual([]);
  });

  it('enforces the length ceiling the schema carries, in code points', () => {
    expect(check({ business_description: 'x'.repeat(20) })).toEqual([]);
    expect(check({ business_description: 'x'.repeat(21) })).toEqual([
      {
        field: 'business_description',
        severity: 'error',
        message: 'Business description must be 20 characters or fewer (currently 21).',
      },
    ]);
    // 20 astral characters are 40 UTF-16 units; the client typed 20.
    expect(check({ business_description: '𝄞'.repeat(20) })).toEqual([]);
  });

  it('evaluates no rules when the server sent none', () => {
    // A frontend deployed against an older API must degrade to "no warnings",
    // never to a crash or a bogus complaint.
    expect(validateIntake([], [], { last_fy_revenue: -1 })).toEqual([]);
  });
});

describe('issuesByField', () => {
  it('groups every issue under its field', () => {
    const grouped = issuesByField([
      { field: 'a', severity: 'error', message: '1' },
      { field: 'b', severity: 'warning', message: '2' },
      { field: 'a', severity: 'warning', message: '3' },
    ]);
    expect(grouped.get('a')?.map((i) => i.message)).toEqual(['1', '3']);
    expect(grouped.get('b')).toHaveLength(1);
    expect(grouped.get('missing')).toBeUndefined();
  });
});
