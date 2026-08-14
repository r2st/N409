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

/**
 * The rule shapes the fixtures above do not carry, and the answer shapes a
 * form control cannot produce but a resumed draft or a direct API caller can.
 *
 * Every message here is the one `domain/intake.ts` produces for the same
 * answer — the two evaluators are the same code twice, and a case that only
 * exercises one of them is not pinning the parity that arrangement exists for.
 */
describe('validateIntake — rule shapes the standard schema does not use', () => {
  const BOUNDED: IntakeSection[] = [
    {
      key: 'bounds',
      title: 'Bounds',
      description: '',
      fields: [
        {
          key: 'discount_rate',
          label: 'Discount rate',
          type: 'number',
          required: false,
          rules: { min: 1, max: 100 },
        },
        { key: 'round_date', label: 'Round date', type: 'date', required: false },
        { key: 'incorporated_on', label: 'Incorporation date', type: 'date', required: false },
        { key: 'free_choice', label: 'Free choice', type: 'select', required: false },
      ],
    },
  ];

  const check = (answers: Record<string, unknown>, rules: IntakeCrossRule[] = []) =>
    validateIntake(BOUNDED, rules, answers, { today: new Date('2026-08-01T00:00:00Z') });

  it('names the floor when it is not zero, rather than saying "cannot be negative"', () => {
    expect(check({ discount_rate: 0.5 })[0]?.message).toBe('Discount rate must be at least 1.');
    expect(check({ discount_rate: 1 })).toEqual([]);
  });

  it('enforces the ceiling', () => {
    expect(check({ discount_rate: 101 })[0]?.message).toBe('Discount rate must be at most 100.');
    expect(check({ discount_rate: 100 })).toEqual([]);
  });

  it('reads a number typed as a string, and refuses one that is not a number', () => {
    // Answers arrive as JSON from a saved draft, where a number input's value
    // is a string. Refusing those would flag every resumed questionnaire.
    expect(check({ discount_rate: '25' })).toEqual([]);
    expect(check({ discount_rate: ' 25 ' })).toEqual([]);
    expect(check({ discount_rate: 'twenty five' })[0]?.message).toBe('Discount rate must be a number.');
    expect(check({ discount_rate: true })[0]?.message).toBe('Discount rate must be a number.');
  });

  it('refuses a number that is not finite', () => {
    // `Infinity` cannot survive JSON, but `1e999` parses back out as it.
    expect(check({ discount_rate: Number.POSITIVE_INFINITY })[0]?.message).toBe(
      'Discount rate must be a number.',
    );
    expect(check({ discount_rate: Number.NaN })[0]?.message).toBe('Discount rate must be a number.');
  });

  it('refuses a date answered as something other than a string', () => {
    expect(check({ round_date: 20260801 })[0]?.message).toBe('Round date must be a valid date (YYYY-MM-DD).');
    expect(check({ round_date: '2026-08-01' })).toEqual([]);
    // Surrounding whitespace is the client's, not an invalid date.
    expect(check({ round_date: ' 2026-08-01 ' })).toEqual([]);
  });

  it('accepts any string for a select the schema gave no options for', () => {
    expect(check({ free_choice: 'anything at all' })).toEqual([]);
    expect(check({ free_choice: '   ' })).toEqual([]);
  });

  it('compares two dates, not their text', () => {
    const rule: IntakeCrossRule = {
      key: 'round_before_incorporation',
      field: 'round_date',
      severity: 'error',
      left: 'round_date',
      op: 'lt',
      right: 'incorporated_on',
      message: 'The round closed before the company was incorporated.',
    };
    expect(check({ round_date: '2019-01-01', incorporated_on: '2020-06-01' }, [rule])).toEqual([
      { field: 'round_date', severity: 'error', message: rule.message },
    ]);
    expect(check({ round_date: '2021-01-01', incorporated_on: '2020-06-01' }, [rule])).toEqual([]);
    // Same day is not before it.
    expect(check({ round_date: '2020-06-01', incorporated_on: '2020-06-01' }, [rule])).toEqual([]);
    // An impossible date is no comparison at all — the field's own error stands.
    expect(
      check({ round_date: '2020-02-30', incorporated_on: '2020-06-01' }, [rule]).map((i) => i.message),
    ).toEqual(['Round date must be a valid date (YYYY-MM-DD).']);
  });

  it('evaluates the inclusive operators the server may send', () => {
    const withOp = (op: IntakeCrossRule['op']): IntakeCrossRule => ({
      key: `rate_${op}`,
      field: 'discount_rate',
      severity: 'warning',
      left: 'discount_rate',
      op,
      right: 25,
      message: `fired: ${op}`,
    });
    expect(check({ discount_rate: 25 }, [withOp('gte')]).map((i) => i.message)).toEqual(['fired: gte']);
    expect(check({ discount_rate: 25 }, [withOp('lte')]).map((i) => i.message)).toEqual(['fired: lte']);
    expect(check({ discount_rate: 25 }, [withOp('gt')])).toEqual([]);
    expect(check({ discount_rate: 25 }, [withOp('lt')])).toEqual([]);
  });

  it('skips a rule whose guard field is unanswered', () => {
    const rule: IntakeCrossRule = {
      key: 'guarded',
      field: 'discount_rate',
      severity: 'warning',
      left: 'discount_rate',
      op: 'gt',
      right: 0,
      when: { field: 'free_choice', equals: ['yes'] },
      message: 'fired',
    };
    expect(check({ discount_rate: 10 }, [rule])).toEqual([]);
    expect(check({ discount_rate: 10, free_choice: 'yes' }, [rule]).map((i) => i.message)).toEqual(['fired']);
  });
});

describe('isValidIsoDate — the shape check before the calendar check', () => {
  it('refuses anything that is not YYYY-MM-DD', () => {
    expect(isValidIsoDate('')).toBe(false);
    expect(isValidIsoDate('01/02/2023')).toBe(false);
    expect(isValidIsoDate('2023-1-2')).toBe(false);
    expect(isValidIsoDate('2023-01-02T00:00:00Z')).toBe(false);
    expect(isValidIsoDate('not a date')).toBe(false);
  });

  it('accepts a well-formed day at either end of the range', () => {
    expect(isValidIsoDate('1900-01-01')).toBe(true);
    expect(isValidIsoDate('2999-12-31')).toBe(true);
  });
});
