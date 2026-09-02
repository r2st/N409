import { z } from 'zod';

/**
 * ISO 4217 currency-code validation for the write boundaries.
 *
 * Every route that accepted a currency spelled it `z.string().length(3)`, which
 * is a length check, not a code check: `"123"`, `"$$$"` and `"us1"` all passed
 * and all reached `char(3)` in the database intact. `Intl.NumberFormat` rejects
 * a code that is not three letters with a *RangeError*, so a valuation stored
 * with one of those crashed every money value the browser tried to render —
 * the dashboard list, the valuation detail, the portfolio totals — for as long
 * as the row existed. A thrown formatter is not a bad-looking cell; it takes
 * the render down.
 *
 * Three ASCII letters is the whole of ISO 4217's shape, and it is exactly what
 * `Intl` demands. The list of *assigned* codes is not checked: it changes
 * without us, and an unassigned-but-well-formed code formats fine (`ABC 12.34`)
 * rather than throwing, so refusing it would reject more real currencies than
 * it caught typos.
 *
 * Normalised to upper case, so a client sending `usd` stores the same code as
 * one sending `USD` and the two group together in the portfolio totals.
 */
export const CURRENCY_CODE = /^[A-Za-z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return CURRENCY_CODE.test(value);
}

/** `z.string()` for a currency column: 3 ASCII letters, upper-cased. */
export const CurrencyCode = z
  .string()
  .trim()
  .regex(CURRENCY_CODE, 'Expected a 3-letter ISO 4217 currency code')
  .transform((s) => s.toUpperCase());

/**
 * ISO-3166 alpha-2 country-code validation for `service_countries`.
 *
 * The same shape, and the same argument, as `CurrencyCode` above — which was
 * written because "every route that accepted a currency spelled it
 * `z.string().length(3)`, which is a length check, not a code check". The three
 * doors onto `service_countries` — `POST /valuations`, and the partner API's
 * create and update — all still spell it `z.string().length(2)`, and every one
 * of them documents the field as "ISO-3166 alpha-2". `"12"`, `"$$"` and `"  "`
 * are all two characters, and all three reached the `text[]` column intact,
 * from a partner API key rather than from a form.
 *
 * The list of *assigned* codes is deliberately not checked, for the reason the
 * currency comment gives: it changes without us, and a well-formed code that is
 * not on today's list is a country this platform should not be refusing to
 * serve.
 *
 * Upper-cased on the way in, so a client sending `gb` stores the same code as
 * one sending `GB`. Not cosmetic: these are a *set*, and the auditor workbook
 * joins them into one cell — `["gb", "GB"]` prints as "gb, GB", which reads as
 * two jurisdictions on the engagement rather than one written twice.
 */
export const COUNTRY_CODE = /^[A-Za-z]{2}$/;

/** `z.string()` for one member of `service_countries`: 2 ASCII letters, upper-cased. */
export const CountryCode = z
  .string()
  .trim()
  .regex(COUNTRY_CODE, 'Expected a 2-letter ISO-3166 alpha-2 country code')
  .transform((s) => s.toUpperCase());
