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
