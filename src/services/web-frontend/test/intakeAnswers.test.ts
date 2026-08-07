import { describe, expect, it } from 'vitest';
import { answerFromControl, controlValue } from '../src/lib/intakeAnswers';
import type { IntakeField } from '../src/lib/intakeValidation';

/**
 * The conversion between a stored intake answer and the control that shows it.
 *
 * Both intake surfaces render the same schema, and each had its own copy of
 * this. They disagreed about exactly one case — the blank option of a yes/no
 * field — and that case is a client recording an answer they did not give. So
 * the conversion is one function now, and the blank cases are pinned per type.
 */

const field = (type: IntakeField['type'], extra: Partial<IntakeField> = {}): IntakeField => ({
  key: 'k',
  label: 'Label',
  type,
  required: false,
  ...extra,
});

describe('controlValue', () => {
  it('shows a boolean as yes/no', () => {
    expect(controlValue({ k: true }, 'k')).toBe('yes');
    expect(controlValue({ k: false }, 'k')).toBe('no');
  });

  it('shows an unanswered field as blank', () => {
    expect(controlValue({}, 'k')).toBe('');
    expect(controlValue({ k: null }, 'k')).toBe('');
  });

  it('shows zero as "0", not as blank', () => {
    // The one number a `?? ''` idiom gets wrong, and a real answer: a company
    // with no employees yet, or no cash on hand.
    expect(controlValue({ k: 0 }, 'k')).toBe('0');
  });
});

describe('answerFromControl', () => {
  /**
   * The wizard read the blank option as `e.target.value === 'yes'` — i.e.
   * `false`. Choosing "—" on "Any pending litigation?" therefore recorded a
   * denial, and `false` counts as answered, so the completion tracker stopped
   * asking about a question the client had deliberately left alone.
   */
  it('reads a cleared yes/no as no answer, not as "no"', () => {
    expect(answerFromControl(field('boolean'), '')).toBeNull();
    expect(answerFromControl(field('boolean'), 'yes')).toBe(true);
    expect(answerFromControl(field('boolean'), 'no')).toBe(false);
  });

  it('reads a cleared number as no answer, not as zero', () => {
    expect(answerFromControl(field('number'), '')).toBeNull();
    expect(answerFromControl(field('number'), '0')).toBe(0);
    expect(answerFromControl(field('number'), '12.5')).toBe(12.5);
  });

  it('reads a cleared choice, date or text as no answer', () => {
    for (const type of ['select', 'date', 'text', 'textarea'] as const) {
      expect(answerFromControl(field(type), ''), type).toBeNull();
    }
  });

  it('keeps text as typed', () => {
    expect(answerFromControl(field('text'), 'Northwind Robotics, Inc.')).toBe('Northwind Robotics, Inc.');
    expect(answerFromControl(field('select'), 'post_revenue')).toBe('post_revenue');
    expect(answerFromControl(field('date'), '2024-02-29')).toBe('2024-02-29');
  });

  it('keeps an unparseable number as the raw string rather than storing NaN', () => {
    // A number input never produces this; a paste into a non-number control
    // could. `validateIntake` then says "must be a number" — a NaN would have
    // been serialised to null and silently read as unanswered.
    expect(answerFromControl(field('number'), 'twelve')).toBe('twelve');
  });
});
