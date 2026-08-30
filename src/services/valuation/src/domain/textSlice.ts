/**
 * Truncating text without cutting a character in half.
 *
 * `String.prototype.slice` counts UTF-16 code units, and an astral character —
 * an emoji, a CJK extension ideograph, a musical symbol, a flag — is two of
 * them. A cut that lands between the halves leaves an unpaired surrogate: a
 * string JavaScript will hold and UTF-8 cannot encode, so every layer below
 * gives its own wrong answer.
 *
 *   - a `jsonb` parameter is refused outright. `JSON.stringify` emits the half
 *     as the literal escape `\ud800` and Postgres's JSON parser rejects an
 *     unpaired one, so the write fails with `22P02` and the request 500s.
 *   - a `text` parameter is encoded with the half replaced by `U+FFFD`, so the
 *     value stored is not the value the caller sent.
 *   - XML — a spreadsheet's sheet names and cell text — has no production for
 *     a lone surrogate either, and the same `U+FFFD` lands in the file.
 *
 * The boundary hook that refuses the character in a request body
 * (domain/nulBytes.ts) cannot help with any of this, because the half-character
 * never arrived: it was created here, by a bound this service applies itself.
 * R217 found it on a document filename — 199 characters and an emoji, which is
 * a thing a phone names a photo — where the cut turned an upload into a 500.
 *
 * The unit is the code point, not the grapheme cluster. Splitting a family
 * emoji or a combining accent from its base is a rendering loss and nothing
 * more; splitting a surrogate pair is a string no layer below can store.
 */
export function sliceChars(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  // A high surrogate in the final position lost its partner to the cut.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * `sliceChars` with an ellipsis, for the summaries that mark what they cut.
 *
 * `max` is the length at which a value is considered long enough to shorten;
 * `keep` is how much of it survives. They differ so the result is visibly
 * shorter than the threshold rather than exactly it — which is how both callers
 * were already written, three characters apart.
 */
export function ellipsize(value: string, max: number, keep = max - 3): string {
  return value.length > max ? `${sliceChars(value, keep)}\u2026` : value;
}
