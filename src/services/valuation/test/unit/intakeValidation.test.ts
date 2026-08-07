import { describe, expect, it } from 'vitest';
import {
  EARLIEST_PLAUSIBLE_DATE,
  hasBlockingIssues,
  INTAKE_CROSS_RULES,
  INTAKE_SECTIONS,
  isValidIsoDate,
  MAX_TEXT_LENGTH,
  MAX_TEXTAREA_LENGTH,
  narrowIntakeAnswers,
  validateIntake,
  type IntakeIssue,
} from '../../src/domain/intake.js';

/**
 * Answer validation for the intake questionnaire.
 *
 * These are the mistakes a client actually makes on this form — a burn figure
 * typed as a negative, a date input that swallowed a keystroke, an option pool
 * that already sits inside the share count — and the distinction the whole
 * feature rests on: an impossible answer blocks submission, an unusual one
 * only asks a question.
 */

const TODAY = new Date('2026-08-01T00:00:00Z');

const validate = (answers: Record<string, unknown>): IntakeIssue[] =>
  validateIntake(answers, { today: TODAY });

const messagesFor = (answers: Record<string, unknown>, field: string): string[] =>
  validate(answers)
    .filter((i) => i.field === field)
    .map((i) => i.message);

describe('isValidIsoDate', () => {
  it('accepts a real calendar day', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects a day the month does not have', () => {
    // new Date('2023-02-30') silently rolls forward to 2 March rather than
    // failing, which is exactly how such a date reaches the engine unnoticed.
    expect(isValidIsoDate('2023-02-30')).toBe(false);
    expect(isValidIsoDate('2024-02-30')).toBe(false);
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    expect(isValidIsoDate('01/02/2024')).toBe(false);
    expect(isValidIsoDate('2024-2-1')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
  });
});

describe('validateIntake — blank answers', () => {
  it('says nothing about an empty form', () => {
    expect(validate({})).toEqual([]);
  });

  it('says nothing about fields left blank', () => {
    // Missing required answers are the completion tracker's business. Warning
    // about them here would flag a form the client simply has not finished.
    expect(validate({ legal_name: '', last_fy_revenue: null, incorporation_date: undefined })).toEqual([]);
  });

  it('treats zero and false as answered, not blank', () => {
    expect(validate({ last_fy_revenue: 0, has_articles: false })).toEqual([]);
  });
});

describe('validateIntake — numbers', () => {
  it('refuses negative revenue', () => {
    expect(messagesFor({ last_fy_revenue: -1 }, 'last_fy_revenue')).toEqual([
      'Last fiscal-year revenue cannot be negative.',
    ]);
  });

  it('refuses a negative burn, which clients type as a minus out of habit', () => {
    expect(messagesFor({ monthly_burn: -40_000 }, 'monthly_burn')).toEqual([
      'Monthly net burn cannot be negative.',
    ]);
  });

  it('refuses negative cash and negative headcount', () => {
    expect(messagesFor({ cash_on_hand: -5 }, 'cash_on_hand')).toHaveLength(1);
    expect(messagesFor({ employee_count: -2 }, 'employee_count')).toContain(
      'Number of employees cannot be negative.',
    );
  });

  it('requires whole shares and whole headcounts', () => {
    expect(messagesFor({ total_shares_outstanding: 1_000_000.5 }, 'total_shares_outstanding')).toEqual([
      'Total shares outstanding must be a whole number.',
    ]);
    expect(messagesFor({ employee_count: 3.5 }, 'employee_count')).toEqual([
      'Number of employees must be a whole number.',
    ]);
  });

  it('requires at least one share outstanding', () => {
    expect(messagesFor({ total_shares_outstanding: 0 }, 'total_shares_outstanding')).toEqual([
      'Total shares outstanding must be at least 1.',
    ]);
  });

  it('rejects text in a numeric field', () => {
    expect(messagesFor({ cash_on_hand: 'about a million' }, 'cash_on_hand')).toEqual([
      'Cash on hand must be a number.',
    ]);
  });

  it('accepts a numeric string, because JSON answers arrive both ways', () => {
    expect(validate({ last_fy_revenue: '250000' })).toEqual([]);
  });

  it('accepts a legitimate zero-revenue company', () => {
    expect(validate({ last_fy_revenue: 0, ytd_revenue: 0 })).toEqual([]);
  });
});

describe('validateIntake — dates', () => {
  it('rejects a date that is not a real day', () => {
    expect(messagesFor({ incorporation_date: '2023-02-30' }, 'incorporation_date')).toEqual([
      'Date of incorporation must be a valid date (YYYY-MM-DD).',
    ]);
  });

  it('rejects a date in the future', () => {
    expect(messagesFor({ incorporation_date: '2026-08-02' }, 'incorporation_date')).toEqual([
      'Date of incorporation cannot be in the future.',
    ]);
  });

  it('accepts today', () => {
    expect(validate({ incorporation_date: '2026-08-01' })).toEqual([]);
  });

  it('catches the slipped keystroke that produces a fourth-century date', () => {
    const messages = messagesFor({ incorporation_date: '0202-05-14' }, 'incorporation_date');
    expect(messages).toEqual([
      `Date of incorporation looks mistyped — it is before ${EARLIEST_PLAUSIBLE_DATE}.`,
    ]);
  });

  it('applies the same rules to the round close date', () => {
    expect(messagesFor({ last_round_date: '2030-01-01' }, 'last_round_date')).toEqual([
      'Most recent round close date cannot be in the future.',
    ]);
  });
});

describe('validateIntake — select fields', () => {
  it('rejects a value outside the offered options', () => {
    expect(messagesFor({ revenue_status: 'maybe' }, 'revenue_status')).toEqual([
      'Revenue stage is not one of the offered choices.',
    ]);
  });

  it('accepts an offered option', () => {
    expect(validate({ revenue_status: 'post_revenue' })).toEqual([]);
  });

  /**
   * The option check used to require `typeof value === 'string'` as part of its
   * *condition*, so a non-string answer skipped it rather than failing it. That
   * is not a theoretical hole: `isAnswered` counts any non-blank value, so a
   * required select answered with an object read as complete AND as valid, and
   * the submit gate — which only asks those two questions — let it through.
   */
  it('rejects a non-string answer instead of skipping the check', () => {
    for (const value of [5, true, { $ne: null }, ['post_revenue']]) {
      expect(messagesFor({ revenue_status: value }, 'revenue_status'), JSON.stringify(value)).toEqual([
        'Revenue stage must be one of the offered choices.',
      ]);
    }
  });
});

describe('validateIntake — text and boolean shapes', () => {
  it('refuses a non-string answer to a text field', () => {
    expect(messagesFor({ legal_name: { toString: 'Acme' } }, 'legal_name')).toEqual([
      'Legal company name must be text.',
    ]);
    expect(messagesFor({ business_description: [1, 2] }, 'business_description')).toEqual([
      'Business description must be text.',
    ]);
  });

  it('refuses a non-boolean answer to a yes/no field', () => {
    expect(messagesFor({ has_articles: 'yes' }, 'has_articles')).toEqual([
      'Articles of incorporation available? must be answered yes or no.',
    ]);
    expect(messagesFor({ pending_litigation: 1 }, 'pending_litigation')).toEqual([
      'Any pending litigation? must be answered yes or no.',
    ]);
  });

  it('accepts either boolean', () => {
    expect(validate({ has_articles: true, pending_litigation: false })).toEqual([]);
  });

  it('caps free text at the length the schema advertises', () => {
    expect(messagesFor({ legal_name: 'a'.repeat(301) }, 'legal_name')).toEqual([
      'Legal company name must be 300 characters or fewer (currently 301).',
    ]);
    expect(validate({ legal_name: 'a'.repeat(300) })).toEqual([]);
  });

  it('gives the textarea more room than a one-line field', () => {
    expect(validate({ business_description: 'x'.repeat(5000) })).toEqual([]);
    expect(messagesFor({ business_description: 'x'.repeat(5001) }, 'business_description')).toHaveLength(1);
  });

  it('counts length in code points, not UTF-16 units', () => {
    // '𝄞' is one character to the person typing it and two to `String.length`.
    // Counting units would refuse a 151-note name against a 300 limit.
    expect(validate({ legal_name: '𝄞'.repeat(300) })).toEqual([]);
    expect(messagesFor({ legal_name: '𝄞'.repeat(301) }, 'legal_name')).toEqual([
      'Legal company name must be 300 characters or fewer (currently 301).',
    ]);
  });

  it('gives every free-text field a length ceiling', () => {
    const textFields = INTAKE_SECTIONS.flatMap((s) => s.fields).filter(
      (f) => f.type === 'text' || f.type === 'textarea',
    );
    expect(textFields.length).toBeGreaterThan(0);
    for (const f of textFields) {
      expect(f.rules?.maxLength, f.key).toBe(f.type === 'textarea' ? MAX_TEXTAREA_LENGTH : MAX_TEXT_LENGTH);
    }
  });
});

describe('narrowIntakeAnswers', () => {
  /**
   * The portal write endpoint is anonymous and its body is `record(unknown)`,
   * so this is the only thing between a hand-written request and a jsonb
   * column. It ran on keys alone: `{"legal_name": {...}}` was stored verbatim
   * and the firm console rendered the company's legal name as "[object
   * Object]".
   */
  it('drops keys the questionnaire does not define', () => {
    expect(narrowIntakeAnswers({ legal_name: 'Acme', nope: 'x', __proto__: 'y' })).toEqual({
      legal_name: 'Acme',
    });
  });

  it('drops objects and arrays, whatever their key', () => {
    expect(
      narrowIntakeAnswers({
        legal_name: { $ne: null },
        business_description: ['a', 'b'],
        revenue_status: {},
        industry: 'Robotics',
      }),
    ).toEqual({ industry: 'Robotics' });
  });

  it('keeps every scalar the wizard can produce, including the falsy ones', () => {
    expect(
      narrowIntakeAnswers({
        legal_name: '',
        employee_count: 0,
        has_articles: false,
        last_round_date: null,
      }),
    ).toEqual({ legal_name: '', employee_count: 0, has_articles: false, last_round_date: null });
  });

  it('leaves a dropped value absent rather than nulling the stored answer', () => {
    // Saves merge in SQL (`answers || $2`), so writing `null` here would erase
    // an answer the client gave earlier. Omission leaves it standing.
    expect(narrowIntakeAnswers({ legal_name: { bad: true } })).toEqual({});
  });
});

describe('validateIntake — cross-field rules', () => {
  it('rejects a round that closed before the company existed', () => {
    const issues = validate({ incorporation_date: '2021-06-01', last_round_date: '2020-01-15' });
    expect(issues).toEqual([
      {
        field: 'last_round_date',
        severity: 'error',
        message: 'The most recent round closed before the company was incorporated.',
      },
    ]);
  });

  it('allows a round on the incorporation date itself', () => {
    expect(validate({ incorporation_date: '2021-06-01', last_round_date: '2021-06-01' })).toEqual([]);
  });

  it('warns — does not block — when the option pool exceeds shares outstanding', () => {
    const issues = validate({ total_shares_outstanding: 1_000_000, option_pool_size: 1_200_000 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'option_pool_size', severity: 'warning' });
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it('warns when burn exceeds cash on hand', () => {
    const issues = validate({ cash_on_hand: 100_000, monthly_burn: 150_000 });
    expect(issues).toEqual([
      {
        field: 'monthly_burn',
        severity: 'warning',
        message: 'Monthly burn is greater than cash on hand — that is under one month of runway.',
      },
    ]);
  });

  it('warns when a pre-revenue company reports revenue', () => {
    const issues = validate({ revenue_status: 'pre_revenue', last_fy_revenue: 400_000 });
    expect(issues).toEqual([
      {
        field: 'last_fy_revenue',
        severity: 'warning',
        message: 'The company is marked pre-revenue but reports last fiscal-year revenue above zero.',
      },
    ]);
  });

  it('stays quiet when the guard does not match', () => {
    // Same figures, post-revenue: entirely normal.
    expect(validate({ revenue_status: 'post_revenue', last_fy_revenue: 400_000 })).toEqual([]);
  });

  it('needs both sides answered before it fires', () => {
    // A round date with no incorporation date says nothing about ordering.
    expect(validate({ last_round_date: '2020-01-15' })).toEqual([]);
    expect(validate({ option_pool_size: 5_000_000 })).toEqual([]);
  });

  it('does not fire on an unparseable operand', () => {
    // The field error already covers it; a second, derived complaint would
    // just be noise on the same mistake.
    const issues = validate({ total_shares_outstanding: 'lots', option_pool_size: 500 });
    expect(issues.map((i) => i.field)).toEqual(['total_shares_outstanding']);
  });
});

describe('hasBlockingIssues', () => {
  it('blocks on errors only', () => {
    expect(hasBlockingIssues([])).toBe(false);
    expect(hasBlockingIssues([{ field: 'a', severity: 'warning', message: 'x' }])).toBe(false);
    expect(hasBlockingIssues([{ field: 'a', severity: 'error', message: 'x' }])).toBe(true);
  });
});

describe('rule set integrity', () => {
  const fieldKeys = new Set(INTAKE_SECTIONS.flatMap((s) => s.fields.map((f) => f.key)));

  it('references only fields the questionnaire actually has', () => {
    // A rule naming a renamed field would silently never fire, which is worse
    // than a broken rule: the form would look validated and not be.
    for (const rule of INTAKE_CROSS_RULES) {
      expect(fieldKeys, `${rule.key}.field`).toContain(rule.field);
      expect(fieldKeys, `${rule.key}.left`).toContain(rule.left);
      if (typeof rule.right === 'string') expect(fieldKeys, `${rule.key}.right`).toContain(rule.right);
      if (rule.when) expect(fieldKeys, `${rule.key}.when`).toContain(rule.when.field);
    }
  });

  it('guards every date field against typos and future dates', () => {
    const dateFields = INTAKE_SECTIONS.flatMap((s) => s.fields).filter((f) => f.type === 'date');
    expect(dateFields.length).toBeGreaterThan(0);
    for (const f of dateFields) {
      expect(f.rules?.notFuture, f.key).toBe(true);
      expect(f.rules?.minDate, f.key).toBe(EARLIEST_PLAUSIBLE_DATE);
    }
  });

  it('gives every money and share field a floor of zero', () => {
    const moneyFields = [
      'last_fy_revenue',
      'ytd_revenue',
      'cash_on_hand',
      'monthly_burn',
      'option_pool_size',
      'last_round_price',
      'employee_count',
    ];
    const byKey = new Map(INTAKE_SECTIONS.flatMap((s) => s.fields).map((f) => [f.key, f]));
    for (const key of moneyFields) {
      expect(byKey.get(key)?.rules?.min, key).toBe(0);
    }
  });

  it('has unique rule keys', () => {
    const keys = INTAKE_CROSS_RULES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
