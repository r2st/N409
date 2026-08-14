/**
 * Escaping for the substring searches every list endpoint offers.
 *
 * A search box matches a substring, so each one wraps the query in `%…%` and
 * hands it to ILIKE. If the query is not escaped first, the characters the
 * user typed are read as the pattern language: `%` matches any run and `_`
 * matches any single character. A company genuinely called "100% Renewable"
 * could not be found by typing its name — the pattern matched every row in
 * scope instead — and a bare `%` turned the narrowest possible query into no
 * filter at all.
 *
 * Backslash is Postgres's default LIKE escape character, so escaping it too is
 * what keeps a literal backslash literal.
 */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

/** The `%…%` ILIKE pattern for a substring search, with the query escaped. */
export function likeContains(s: string): string {
  return `%${escapeLike(s)}%`;
}

/** `alias.` when there is one, so the helpers below work unqualified too. */
function prefix(alias: string): string {
  return alias ? `${alias}.` : '';
}

/**
 * A person's first and last name as one string, joined by a space.
 *
 * This exists as a helper — rather than being written out at each of the four
 * places that search a name — because the trigram index in migration 0149 is
 * built on this exact expression, and the planner only uses an expression index
 * when the query's expression matches it. Two copies of "the full name" that
 * drift apart do not fail; they silently go back to a sequential scan. One
 * source, used by both the index and every caller, is what keeps that from
 * happening.
 *
 * It is `coalesce(…) || ' ' || coalesce(…)` and not `concat_ws(' ', …)`, which
 * is what three of the callers used to say, because concat_ws is STABLE rather
 * than IMMUTABLE — it accepts `any` and has to call the type's output function
 * — and Postgres will not build an index on a stable expression at all.
 *
 * The two forms differ in one case: concat_ws drops a null instead of
 * contributing an empty string, so a user with no first name reads as `Ada`
 * there and ` Ada` here. For the `%…%` contains match these are only ever used
 * for, that is the same answer unless the query itself has a leading space.
 */
export function userFullNameSql(alias = ''): string {
  const p = prefix(alias);
  return `(coalesce(${p}first_name, '') || ' ' || coalesce(${p}last_name, ''))`;
}

/**
 * The predicate behind every "find a person" box: match the address or the
 * name, both as substrings, against one already-bound `%…%` parameter.
 *
 * Both arms are trigram-indexed (0149), so the planner can serve them from a
 * bitmap OR of two index scans instead of reading `users` end to end.
 *
 * The admin console asked this as a single `concat_ws(' ', email, first, last)`
 * match before, which no index can serve. Splitting it into the two arms costs
 * one thing and gains another: a query can no longer span the join between the
 * address and the name — `"ada@corp.com ada"` matched the concatenation and
 * matches nothing now — while a query spanning first and last (`"ada lovelace"`,
 * the case anyone actually types) still matches, through `userFullNameSql`.
 */
export function userSearchSql(param: string, alias = ''): string {
  return `(${prefix(alias)}email ILIKE ${param} OR ${userFullNameSql(alias)} ILIKE ${param})`;
}
