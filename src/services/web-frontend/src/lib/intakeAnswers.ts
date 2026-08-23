import type { IntakeField } from './intakeValidation';

/**
 * The two directions between a stored intake answer and the form control that
 * shows it.
 *
 * Both intake surfaces — the anonymous client portal and the signed-in wizard
 * inside a valuation — render the same schema with the same controls, and each
 * had grown its own copy of this conversion. They disagreed, and the
 * disagreement was not cosmetic: the wizard read the blank option of a yes/no
 * field as `false` rather than as "no answer", so a client who selected "—" on
 * "Any pending litigation?" recorded a denial they never made. Worse, `false`
 * counts as answered, so the field then read as complete and the completion
 * tracker stopped asking.
 *
 * One implementation, two callers.
 */

/** What a control displays for a stored answer. Booleans read as yes/no. */
export function controlValue(answers: Record<string, unknown>, key: string): string {
  const v = answers[key];
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

/**
 * The answer a control's raw string means, typed by the field.
 *
 * Empty is always `null` — "cleared", never a zero or a `false`. A save merges
 * server-side, so the difference decides whether an earlier answer is erased or
 * silently replaced with one the client did not give.
 */
export function answerFromControl(field: IntakeField, raw: string): unknown {
  if (raw === '') return null;
  if (field.type === 'boolean') return raw === 'yes';
  if (field.type === 'number') {
    const n = Number(raw);
    // A number input hands back '' for anything it cannot parse, so this only
    // fires for a caller that is not a number input. Keeping the raw string
    // lets `validateIntake` say "must be a number" instead of storing a NaN.
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

/** Just enough of a section's completion state to decide where to resume. */
export interface ResumeSection {
  complete: boolean;
}

/**
 * The step a returning client should land on.
 *
 * Intake autosaves, so a client who closes the tab halfway keeps every answer —
 * but the wizard always opened at step 0, which meant the longest forms
 * reopened on the section the client finished first. Getting back to where they
 * stopped was a manual walk through sections that already showed a tick, and it
 * is the point in the funnel where a half-finished intake is abandoned for good.
 *
 * The first incomplete section is the resume point, not the furthest one
 * reached: sections can be revisited and answers cleared, and the section a
 * client still owes us an answer for is the one worth opening on. When nothing
 * is outstanding the review step is the answer — the remaining action is to
 * submit, and opening on the last question of a finished form hides the button
 * that ends the process.
 *
 * A form with no sections resolves to 0, which is its review step too.
 */
export function resumeStep(sections: readonly ResumeSection[]): number {
  const firstIncomplete = sections.findIndex((s) => !s.complete);
  return firstIncomplete === -1 ? sections.length : firstIncomplete;
}

// ── The link's own clock ──────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many days left stops being a footnote and becomes something to say.
 *
 * The same window the workspace uses for a due date (`DUE_SOON_DAYS`), for the
 * same reason: a week is long enough to find the cap table and short enough
 * that "sometime" is no longer an answer.
 */
export const INTAKE_DEADLINE_WARN_DAYS = 7;

export interface IntakeDeadline {
  /** The expiry instant, for formatting in the client's own locale. */
  at: Date;
  /** Whole calendar days from today. 0 is today; negative has passed. */
  daysLeft: number;
  /** Whether the client should be *told*, rather than merely shown. */
  urgent: boolean;
}

/**
 * When this intake link stops working, as a client would count it.
 *
 * Counted in whole calendar days between local midnights rather than in
 * elapsed hours, because "expires in 1 day" for something that dies at nine
 * tomorrow morning is a different promise from the one a client hears. Rounding
 * across the two midnights is also what keeps a clock change from turning a
 * seven-day window into a six-and-three-quarter-day one.
 *
 * A firm sets the window per link — anywhere from a day to `MAX_EXPIRY_DAYS`,
 * defaulting to thirty — and until now the client was never told what it was.
 * The page's own standing promise is that they can close it and pick it up from
 * the same link, and that promise has an end date the form did not name.
 */
export function intakeDeadline(expiresAt: string | null | undefined, now: Date): IntakeDeadline | null {
  if (!expiresAt) return null;
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const then = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const daysLeft = Math.round((then - today) / DAY_MS);
  return { at, daysLeft, urgent: daysLeft <= INTAKE_DEADLINE_WARN_DAYS };
}

/**
 * The same figure in the words a person uses.
 *
 * "Expires in 0 days" is not something anyone says, and it is the reading that
 * matters most — the last day is the day the form is either finished or lost.
 */
export function deadlineInWords(daysLeft: number): string {
  if (daysLeft < 0) return 'has expired';
  if (daysLeft === 0) return 'expires today';
  if (daysLeft === 1) return 'expires tomorrow';
  return `expires in ${daysLeft} days`;
}
