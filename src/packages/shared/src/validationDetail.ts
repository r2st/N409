/**
 * Turns a schema's rejection into the sentence the person who typed it reads.
 *
 * Every validation failure on this API was answered with a category noun —
 * "Invalid query", "Invalid request", "Invalid patch" — and the fields that
 * actually failed travelled beside it, in an `errors` extension holding raw
 * zod issues. That split looks harmless from the server and is not, because of
 * where the two halves end up: `ApiError` in the browser is constructed as
 * `super(problem.detail ?? problem.title)`, so every `setError(err.message)`
 * in the frontend — which is how all of them are written — renders the
 * category noun and nothing else. The extension is in the body, unread. The
 * analyst who left `vintage_year` as `19999` was told "Invalid request" and
 * had no way to find out which of the eleven inputs on the form the server
 * disliked, short of opening devtools.
 *
 * So the field names have to be in `detail`. The extension stays exactly as it
 * was — a machine reading `errors[].path` should not have to parse prose — and
 * this is the human rendering of the same facts, not a replacement for them.
 *
 * Deliberately *not* a translation layer. The message for each issue is
 * whatever the schema said, because the schemas in this estate already carry
 * written-for-a-person messages where the default is unhelpful (`'Expected
 * YYYY-MM-DD'`, `'Not a real calendar date'`), and inventing a second wording
 * here would mean the good ones get overwritten by a generic one. What this
 * adds is the part a zod message structurally cannot have: which field it is
 * about.
 */

/**
 * The shape this reads off a `ZodError`'s `issues`.
 *
 * Structural rather than `import type { ZodIssue }`: `shared` is depended on by
 * the two Fastify services and by the report renderer, and only the first of
 * them has zod. The two fields used here have been stable across every zod
 * major, which is the reason it is safe to restate them rather than import
 * them.
 */
export interface ValidationIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/** Issues named in the sentence before it gives up and counts the rest. */
const MAX_NAMED = 3;

/**
 * `['positions', 0, 'cost_basis']` → `positions[0].cost_basis`.
 *
 * Numeric segments are rendered as indices rather than as another dotted
 * segment because the arrays this API takes are the ones a client *sent* — a
 * bulk grant import, a waterfall's tranches — and `positions.0.cost_basis`
 * does not correspond to anything the caller can look at. `positions[0]` is
 * the row they can count to.
 *
 * An empty path means the whole value failed rather than a field within it: a
 * body that is an array where an object was expected, or a `superRefine` on
 * the root. There is no field to name in that case, and the caller gets the
 * issue's own message unprefixed.
 */
export function issuePath(path: ReadonlyArray<string | number>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

/**
 * A one-line, field-named summary of why a schema refused the input.
 *
 * Bounded at {@link MAX_NAMED} named issues. A schema rejecting a badly-shaped
 * body produces one issue per field it expected, so the unbounded form of this
 * is a paragraph — and the value of an error message falls off a cliff once it
 * stops fitting where the UI puts it. Three names plus a count is enough to
 * act on, and the full list is still in `errors` for anyone who wants it.
 *
 * The count is of the issues *not named*, not the total, so "and 2 more
 * problems" is directly the number still hidden.
 */
export function describeIssues(issues: readonly ValidationIssue[]): string {
  if (issues.length === 0) return '';
  const named = issues.slice(0, MAX_NAMED).map((issue) => {
    const field = issuePath(issue.path);
    return field === '' ? issue.message : `${field}: ${issue.message}`;
  });
  const hidden = issues.length - named.length;
  return hidden > 0
    ? `${named.join('; ')} (and ${hidden} more problem${hidden === 1 ? '' : 's'})`
    : named.join('; ');
}

/**
 * `<subject> — <fields>`, or just `<subject>` when there is nothing to add.
 *
 * The subject survives because it carries the one thing the issue list cannot:
 * *which* input was rejected. A PATCH validates its path parameters, its query
 * and its body against three different schemas, and `page: Expected number`
 * does not say which of the three the caller should go and look at.
 *
 * The empty-issues branch is not defensive padding — `safeParse` failing with
 * zero issues is impossible — it is for the call sites that have no error
 * object to hand at all, which is how a hand-rolled check reaches this.
 */
export function validationDetail(subject: string, issues: readonly ValidationIssue[]): string {
  const described = describeIssues(issues);
  return described === '' ? subject : `${subject} — ${described}`;
}
