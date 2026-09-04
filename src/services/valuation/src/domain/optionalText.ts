import { z } from 'zod';

/**
 * A free-text field a caller is allowed to clear, normalised so that clearing
 * it produces the same value however it was spelled.
 *
 * ## Why the blank has to be normalised rather than merely permitted
 *
 * `nonBlankText` is the answer for a *required* label: refuse the whitespace
 * and name the field. It is the wrong answer here, because these fields may
 * legitimately be emptied — an administrator removing a name someone asked to
 * have removed is not a malformed request — so the question is not whether to
 * accept the blank but what to store for it.
 *
 * `blankLabelCensus` scans only fields with a floor, and says so out loud:
 * "a `z.string().max(200)` with no floor is a field that may be empty by
 * design, and `''` and `'   '` are the same answer there". For a value that is
 * only ever read back as itself that holds. It does not hold for a value read
 * through the house's display-name idiom, which is
 *
 *     [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email
 *
 * — `''` is falsy, so it drops out of the join and the fallback fires; `'   '`
 * is truthy, so it survives the filter, joins to a run of spaces, and the
 * `||` never reaches the address. Four readers spell it that way
 * (`routes/stream.ts`, `routes/savedViews.ts`, and `repos/firmDashboard.ts`
 * twice), and a fifth — `repos/comments.ts` — works around it in SQL with
 * `nullif(trim(concat(u.first_name, ' ', u.last_name)), '')`, which is the
 * same evidence `brand_name` left: a reader written to defend against a value
 * the write should not have taken.
 *
 * So the two blanks are not the same answer, and the one that reads as "no
 * name given" is NULL.
 *
 * ## Trimmed rather than refused
 *
 * The opposite choice from `nonBlankText`, which argues that storing a rewrite
 * of what somebody typed is its own kind of lie. The difference is that there
 * the value is required and a refusal tells the caller something they can act
 * on, whereas a trailing space on an optional name is not a mistake worth a
 * 400 — and `routes/account.ts` has trimmed these exact four columns since it
 * was written. This is that rule, hoisted so the administrator's door and the
 * account holder's door are one definition instead of two spellings.
 */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));
