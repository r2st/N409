/**
 * "Cents" is a fact about most currencies, not about money.
 *
 * Every amount the platform holds in minor units came from Stripe, which
 * reports in the currency's own minor unit. For the zero-decimal currencies —
 * JPY, KRW, VND, CLP, ISK — there is no subdivision: `amount: 100000` on a yen
 * charge is ¥100,000. Both formatters divided by 100 regardless, so the invoice
 * PDF, the receipt and the refund notice each told a Japanese customer they had
 * been charged a hundredth of what they were, and pinned two decimal places
 * onto a currency that has none. The three-decimal currencies (BHD, JOD, KWD,
 * OMR, TND) came out a tenth of the amount.
 *
 * The scale is now read from `Intl` on both sides. This pins the server half
 * and the arithmetic they must agree on; the browser half is pinned in
 * web-frontend/test/format-money.test.ts against the same table.
 */
import { describe, expect, it } from 'vitest';
import { formatMoneyCents } from '../../src/domain/billing.js';

/** currency, amount in minor units, what the customer was actually charged. */
const CHARGES: Array<[string, number, string]> = [
  ['usd', 119_000, '$1,190.00'],
  ['gbp', 119_000, '£1,190.00'],
  // No subdivision: the minor unit is the yen, so this is ¥100,000.
  ['jpy', 100_000, '¥100,000'],
  ['krw', 100_000, '₩100,000'],
  ['vnd', 100_000, '₫100,000'],
  // Three decimals: 1,190 fils is 1.190 dinar. `Intl` separates a code it has
  // no symbol for with a non-breaking space.
  ['bhd', 1_190, 'BHD\u00a01.190'],
  ['kwd', 1_190, 'KWD\u00a01.190'],
];

describe('money is scaled by the currency it was charged in', () => {
  it('prints each charge as the amount that left the customer', () => {
    for (const [currency, minor, expected] of CHARGES) {
      expect(`${currency}: ${formatMoneyCents(minor, currency)}`).toBe(`${currency}: ${expected}`);
    }
  });

  it('does not give a zero-decimal currency decimals', () => {
    // "¥1,000.00" is two claims that are both wrong — the amount and the
    // existence of a subunit.
    expect(formatMoneyCents(100_000, 'jpy')).not.toContain('.');
  });

  it('round-trips the scale, so the printed figure is the stored one', () => {
    for (const [currency, minor] of CHARGES) {
      const digits = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency.toUpperCase(),
      }).resolvedOptions().maximumFractionDigits;
      const printed = Number(formatMoneyCents(minor, currency).replace(/[^0-9.]/g, ''));
      expect(Math.round(printed * 10 ** digits)).toBe(minor);
    }
  });

  it('still refuses to throw on a code that is not one', () => {
    // The reason this function exists: a currency column with no constraint on
    // it, feeding three renders whose failure is a customer not being told
    // something about their own money.
    expect(() => formatMoneyCents(119_000, 'not-a-currency')).not.toThrow();
    expect(formatMoneyCents(119_000, 'not-a-currency')).toContain('1,190.00');
    expect(formatMoneyCents(119_000, '')).toBe('$1,190.00');
  });
});
