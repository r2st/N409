import type { IntakeIssue } from '../lib/intakeValidation';

/**
 * The two ways a form answer can be wrong, rendered differently on purpose.
 *
 * An error is red and blocks submission — the answer cannot be true. A warning
 * is amber and blocks nothing: it is a question addressed to the only person
 * who can settle it. Rendering them identically would train clients to ignore
 * both.
 */

/** Warnings for one field, under its control. Errors go through Field's own slot. */
export function FieldWarnings({ issues }: { issues: readonly IntakeIssue[] }) {
  const warnings = issues.filter((i) => i.severity === 'warning');
  if (warnings.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {warnings.map((w) => (
        <li key={w.message} className="flex gap-1.5 text-xs leading-relaxed text-amber-700">
          <span aria-hidden="true">▲</span>
          <span>{w.message}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Whole-form roll-up. Shown near the submit control so a client who scrolled
 * past a warning still meets it before they commit.
 */
export function ValidationSummary({ issues }: { issues: readonly IntakeIssue[] }) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  if (errors.length === 0 && warnings.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="validation-summary">
      {errors.length > 0 && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800"
        >
          <p className="font-semibold">
            {errors.length === 1 ? '1 answer needs fixing' : `${errors.length} answers need fixing`} before
            you can submit.
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {errors.map((e) => (
              <li key={`${e.field}:${e.message}`}>{e.message}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
          <p className="font-semibold">
            {warnings.length === 1 ? '1 answer looks unusual' : `${warnings.length} answers look unusual`} —
            worth a second look, but you can submit either way.
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {warnings.map((w) => (
              <li key={`${w.field}:${w.message}`}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
