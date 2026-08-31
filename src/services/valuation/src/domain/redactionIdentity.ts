/**
 * The engagement owner, turned into the entity lists the redactor is told about
 * — and, separately, into the one fact the record could not previously state.
 *
 * `anonymize.py`'s `Redactor.report()` already draws the distinction this
 * module exists to preserve: `redacted` is what was struck and `declared` is
 * what the run was *told* to look for, because "we were handed the owner's name
 * and never saw it in the documents" and "nobody told us the owner's name" both
 * come back as `{"names": 0}` and mean opposite things.
 *
 * There is a third reading of that same zero, and it was written nowhere. Both
 * routes that resolve the owner do it best-effort — a lookup that fails must
 * not cost a pipeline run or refuse an operator's preview — so a failed read
 * produces exactly the record a client with no name on file produces, on a run
 * that shipped that client's name to an external model in the clear. The only
 * signal was a log line, and a log line is not what anybody reads eighteen
 * months later when asked what a run was given.
 *
 * `first_name` and `last_name` are nullable (migration 0001), so "declared no
 * people" genuinely is the normal record for some accounts. That is precisely
 * why the failure has to be recorded as its own value rather than inferred from
 * a count.
 */

/** What `findRedactionIdentity` / `findUserById` contribute to redaction. */
export interface RedactionIdentity {
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
}

/**
 * The lookup's three outcomes, kept apart.
 *
 * `'unavailable'` is the read that could not run. `null` is the read that ran
 * and found no row — an owner whose account has since been hard-deleted — which
 * is a different fact and, unlike the first, is not going to change on a retry.
 */
export type RedactionIdentityResult = RedactionIdentity | null | 'unavailable';

/** How the record spells each outcome. `input.redaction_identity` on an AI job. */
export type RedactionIdentityState = 'read' | 'missing' | 'unavailable';

export function redactionIdentityState(result: RedactionIdentityResult): RedactionIdentityState {
  if (result === 'unavailable') return 'unavailable';
  return result === null ? 'missing' : 'read';
}

/** True when the owner's entities are absent because the read failed. */
export function isIdentityUnavailable(result: RedactionIdentityResult): boolean {
  return result === 'unavailable';
}

/**
 * The owner's own name and stated employer, as entity lists.
 *
 * Blank-filtered and deduplicated here rather than at each caller: both routes
 * merge these with a list of their own (the operator's typed names, the
 * issuer), and a blank entity is one the redactor would compile a pattern for
 * and match nothing with — or, for a company, one `_short_form` would then
 * derive a second blank from.
 */
export function ownerRedactionEntities(result: RedactionIdentityResult): {
  companies: string[];
  people: string[];
} {
  if (result === 'unavailable' || result === null) return { companies: [], people: [] };
  const person = [result.first_name, result.last_name].filter(Boolean).join(' ').trim();
  const company = (result.company_name ?? '').trim();
  return {
    companies: company === '' ? [] : [company],
    people: person === '' ? [] : [person],
  };
}
