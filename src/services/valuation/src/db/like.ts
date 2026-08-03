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
