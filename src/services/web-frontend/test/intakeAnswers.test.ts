import { describe, expect, it } from 'vitest';
import {
  answerFromControl,
  controlValue,
  deadlineInWords,
  INTAKE_DEADLINE_WARN_DAYS,
  intakeDeadline,
  resumeStep,
} from '../src/lib/intakeAnswers';
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

describe('resumeStep', () => {
  const sections = (...complete: boolean[]) => complete.map((c) => ({ complete: c }));

  it('opens a fresh form at the first section', () => {
    expect(resumeStep(sections(false, false, false))).toBe(0);
  });

  it('reopens on the first section still owing an answer, not the furthest reached', () => {
    // The client finished 1 and 3 and left 2 half-done. Section 2 is the one
    // worth opening on, even though 3 is further along.
    expect(resumeStep(sections(true, false, true))).toBe(1);
  });

  it('skips the run of finished sections at the front', () => {
    expect(resumeStep(sections(true, true, true, false, false))).toBe(3);
  });

  it('lands on the review step when nothing is outstanding', () => {
    // Length, not length - 1: the remaining action is Submit, and opening on
    // the last question of a finished form hides the button that ends it.
    expect(resumeStep(sections(true, true, true))).toBe(3);
  });

  it('resolves a form with no sections to 0, which is its review step', () => {
    expect(resumeStep([])).toBe(0);
  });
});

/**
 * How long a client has left on the link they were sent.
 *
 * Counted in whole calendar days between local midnights, not in elapsed hours:
 * a link that dies at nine tomorrow morning expires *tomorrow*, and telling a
 * client it expires "in 0 days" because sixteen hours is less than
 * twenty-four is both wrong and unreadable.
 */
describe('intakeDeadline', () => {
  /** Local components on both sides, so every case holds in any zone. */
  const local = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h);
  const iso = (...args: Parameters<typeof local>) => local(...args).toISOString();

  const now = local(2026, 7, 23, 9);

  it('counts the days a calendar does, not the hours a clock does', () => {
    // Sixteen hours away, and still tomorrow.
    expect(intakeDeadline(iso(2026, 7, 24, 1), now)!.daysLeft).toBe(1);
    // Fourteen hours away, and still today.
    expect(intakeDeadline(iso(2026, 7, 23, 23), now)!.daysLeft).toBe(0);
    expect(intakeDeadline(iso(2026, 8, 22), now)!.daysLeft).toBe(30);
  });

  it('goes negative once the date has passed', () => {
    expect(intakeDeadline(iso(2026, 7, 22, 23), now)!.daysLeft).toBe(-1);
  });

  /**
   * The window is inclusive of its own edge. A link with exactly a week left is
   * the last one the client can still comfortably act on, and it is the one a
   * strict `<` would say nothing about.
   */
  it('treats exactly the warning window as urgent', () => {
    expect(intakeDeadline(iso(2026, 7, 30), now)!.urgent).toBe(true);
    expect(intakeDeadline(iso(2026, 7, 31), now)!.urgent).toBe(false);
    expect(intakeDeadline(iso(2026, 7, 23 + INTAKE_DEADLINE_WARN_DAYS), now)!.daysLeft).toBe(
      INTAKE_DEADLINE_WARN_DAYS,
    );
  });

  /**
   * Rounding between two local midnights rather than dividing an elapsed
   * interval. A spring-forward inside the window makes the span 167 hours, and
   * a truncating division would call a week six days.
   */
  it('survives a clock change inside the window', () => {
    // US DST begins 8 March 2026; this window straddles it either way the host
    // is set, and the answer is a week in both.
    const before = local(2026, 2, 5, 9);
    expect(intakeDeadline(iso(2026, 2, 12, 9), before)!.daysLeft).toBe(7);
    // And the other direction, across the autumn change.
    const autumn = local(2026, 9, 29, 9);
    expect(intakeDeadline(iso(2026, 10, 5, 9), autumn)!.daysLeft).toBe(7);
  });

  it('has nothing to say about a missing or unreadable date', () => {
    expect(intakeDeadline(null, now)).toBeNull();
    expect(intakeDeadline(undefined, now)).toBeNull();
    expect(intakeDeadline('', now)).toBeNull();
    expect(intakeDeadline('whenever', now)).toBeNull();
  });

  it('hands back the instant itself for the caller to format', () => {
    expect(intakeDeadline(iso(2026, 8, 22), now)!.at.toISOString()).toBe(iso(2026, 8, 22));
  });
});

describe('deadlineInWords', () => {
  it('says today and tomorrow rather than counting to them', () => {
    expect(deadlineInWords(0)).toBe('expires today');
    expect(deadlineInWords(1)).toBe('expires tomorrow');
  });

  it('counts from two upwards', () => {
    expect(deadlineInWords(2)).toBe('expires in 2 days');
    expect(deadlineInWords(30)).toBe('expires in 30 days');
  });

  it('speaks in the past tense once the date is behind us', () => {
    expect(deadlineInWords(-1)).toBe('has expired');
  });
});
