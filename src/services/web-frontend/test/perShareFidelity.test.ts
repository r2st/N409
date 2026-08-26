/**
 * The last hop of the FMV per share, and the only one that was losing digits.
 *
 * Traced end to end (R156), the concluded per-share value survives every
 * transformation between the engine and the deliverable exactly:
 *
 *   - `engine/compute.py` rounds it to four decimals and writes it once, into
 *     both `results.fmv_per_share` and the denormalised `calculations`
 *     column, from the same expression;
 *   - the column is `numeric`, which pg hands back as a *string* — no float
 *     round trip, and no type parser is registered that would introduce one;
 *   - the report body's `{{fmv_per_share}}`, the executive summary headline,
 *     Exhibit H's closing line, the FMV-over-time chart and the workbook's
 *     `pershare` cell are all struck at four (`formatCurrency(…, 4)`), and the
 *     figures are resolved at render from the run rather than written back.
 *
 * The browser was the exception. Five surfaces re-rounded the conclusion on the
 * way to the screen and two of them re-denominated it, so the number a customer
 * read in the app was not the number in the PDF they had been issued. This
 * pins the browser's half to the same contract.
 */
import { describe, expect, it } from 'vitest';
import { formatPerShare, PER_SHARE_DIGITS, formatAmount, moneyFormatter } from '../src/lib/format';
import { formatMoney } from '../src/lib/pipeline';

/**
 * The valuation service's `formatCurrency(value, currency, 4)`, transcribed —
 * `domain/reportSummary.ts`. Transcribed rather than imported because the point
 * is that two independently-maintained renderers agree; importing the server's
 * copy would assert only that a function equals itself.
 *
 * The locale is the server's own `'en-US'`. The browser deliberately formats in
 * the reader's locale, so the two strings are compared on the part that is a
 * contract — the digits and the currency — rather than on grouping and symbol
 * placement, which are meant to differ.
 */
function serverRender(value: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value);
}

/** The digits either side of the decimal separator, with grouping removed. */
function digitsOf(rendered: string): string {
  const body = rendered.replace(/[^\d.,-]/g, '');
  // The last separator is the decimal point; everything before it groups.
  const cut = Math.max(body.lastIndexOf('.'), body.lastIndexOf(','));
  if (cut === -1) return body.replace(/[.,]/g, '');
  return `${body.slice(0, cut).replace(/[.,]/g, '')}.${body.slice(cut + 1)}`;
}

/**
 * Values chosen so that every one of them was rendered *wrongly* by at least
 * one of the formatters this replaces — a sub-cent seed-stage FMV, a figure
 * whose fourth decimal is the only thing distinguishing two runs, one either
 * side of the magnitude threshold `formatMoney` switches on, and a late-stage
 * per-share value where that switch dropped the decimals entirely.
 */
const VALUES = [0.0512, 0.5, 1.2345, 2.5013, 2.5104, 99.9999, 100.0001, 124.5678, 150.25];

describe('formatPerShare states the conclusion at the precision it was concluded at', () => {
  it('keeps all four decimals of the engine figure', () => {
    for (const v of VALUES) {
      expect(digitsOf(formatPerShare(v, 'USD'))).toBe(v.toFixed(PER_SHARE_DIGITS));
    }
  });

  it('agrees digit for digit with the report renderer', () => {
    for (const v of VALUES) {
      expect(digitsOf(formatPerShare(v, 'USD'))).toBe(digitsOf(serverRender(v, 'USD')));
    }
  });

  it('pads to four rather than dropping trailing zeros', () => {
    // $2.50 and $2.5000 are the same number stated to different precisions, and
    // a reader comparing two runs down a column is reading the difference.
    expect(digitsOf(formatPerShare(2.5, 'USD'))).toBe('2.5000');
  });

  it('denominates in the engagement currency, never a default', () => {
    const gbp = formatPerShare(2.5013, 'GBP');
    expect(gbp).not.toContain('$');
    expect(digitsOf(gbp)).toBe('2.5013');
    // Same figure, three engagements, three currencies — and never the same
    // string, which is what a hard-coded symbol produced.
    const seen = new Set(['USD', 'GBP', 'EUR', 'INR'].map((c) => formatPerShare(2.5013, c)));
    expect(seen.size).toBe(4);
  });

  it('survives a currency code Intl cannot format, as moneyFormatter does', () => {
    // Rows predating the ISO-code check carry things like "123"; a throw here
    // unmounts the workspace rather than mis-printing one cell.
    expect(() => formatPerShare(2.5013, '123')).not.toThrow();
    // The code is printed beside the amount rather than as a symbol, so the
    // rendered string ends in the figure — `digitsOf` would otherwise read the
    // numeric code as part of it.
    expect(formatPerShare(2.5013, '123')).toMatch(/\b123\b/);
    expect(formatPerShare(2.5013, '123')).toMatch(/2[.,]5013$/);
  });

  it('reads a numeric column string, which is how the API delivers it', () => {
    // `calculations.fmv_per_share` is `numeric`; node-pg hands it over as text
    // and several routes pass it straight through.
    expect(formatPerShare('2.5013', 'USD')).toBe(formatPerShare(2.5013, 'USD'));
  });

  it('renders no figure rather than a fabricated one', () => {
    for (const empty of [null, undefined, '', 'not a number', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatPerShare(empty as never, 'USD')).toBe('—');
    }
    // Zero is a figure, not an absence: a common share can be concluded at zero
    // and the report says so.
    expect(digitsOf(formatPerShare(0, 'USD'))).toBe('0.0000');
  });

  it('states negatives, which the intangible engines can conclude', () => {
    expect(digitsOf(formatPerShare(-1.2345, 'USD'))).toBe('-1.2345');
  });
});

/**
 * What the browser used to do. These are not hypotheticals — each is the
 * formatter a named surface reached for, run on a value it actually had to
 * render. They are kept as tests so the replacement is measured against the
 * thing it replaced rather than against nothing.
 */
describe('the formatters this replaces do lose the conclusion', () => {
  it('formatMoney drops every decimal once the figure reaches 100', () => {
    // The accented headline card on the Calculations tab, and the Scenarios and
    // Package tables. A late-stage 409A is routinely above $100 a share.
    expect(digitsOf(formatMoney(124.5678, 'USD'))).toBe('125');
    expect(digitsOf(formatPerShare(124.5678, 'USD'))).toBe('124.5678');
  });

  it('a two-decimal formatter collapses a seed-stage walk to nothing', () => {
    // The bridge exists to decompose a change in this number. Struck at two,
    // the whole walk from 0.0512 to 0.0640 happened inside one printed digit.
    const twoDp = moneyFormatter('USD', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(twoDp(0.0512)).toBe(twoDp(0.0499));
    expect(formatPerShare(0.0512, 'USD')).not.toBe(formatPerShare(0.0499, 'USD'));
  });

  it('formatAmount is for cap-table amounts and is not per-share exact', () => {
    // Widens for sub-unit figures, so it looks right on a seed FMV and quietly
    // is not on any other.
    expect(digitsOf(formatAmount(2.5013, 'USD'))).toBe('2.50');
    expect(digitsOf(formatPerShare(2.5013, 'USD'))).toBe('2.5013');
  });
});
