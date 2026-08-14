import { describe, expect, it } from 'vitest';
import {
  displayName,
  eventLabel,
  formatDate,
  formatDateTime,
  formatNumber,
  initials,
  moneyFormatter,
} from '../src/lib/format';

/**
 * The formatters' fallbacks. Every one of these is reached by a row the API
 * already holds — a null name, a timestamp a migration wrote as a bare string,
 * an event type a service added after this build shipped — so the fallback is
 * the branch that actually renders, not a defensive one.
 *
 * `format-money.test.ts` covers the money path; this covers the rest.
 */

describe('formatDate / formatDateTime', () => {
  it('renders a dash for nothing at all', () => {
    for (const empty of [null, undefined, '']) {
      expect(formatDate(empty)).toBe('—');
      expect(formatDateTime(empty)).toBe('—');
    }
  });

  it('renders a dash rather than "Invalid Date" for a timestamp it cannot read', () => {
    // A cell somebody typed into, or a column a migration filled with a
    // non-ISO string. `toLocaleDateString` on an invalid Date prints the
    // literal "Invalid Date", which reads as a bug in the row rather than a
    // gap in it.
    expect(formatDate('not a timestamp')).toBe('—');
    expect(formatDate('2023-13-45')).toBe('—');
    expect(formatDateTime('not a timestamp')).toBe('—');
  });

  it('renders a real timestamp', () => {
    expect(formatDate('2026-07-01T00:00:00Z')).not.toBe('—');
    expect(formatDateTime('2026-07-01T12:30:00Z')).not.toBe('—');
  });
});

describe('formatNumber', () => {
  it('renders a dash for nothing and for a value that is not a number', () => {
    for (const empty of [null, undefined, '']) expect(formatNumber(empty)).toBe('—');
    expect(formatNumber('twelve')).toBe('—');
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
  });

  it('reads a numeric string, which is how a numeric column arrives', () => {
    expect(formatNumber('1234567')).toBe(new Intl.NumberFormat().format(1234567));
    expect(formatNumber(0)).toBe('0');
  });
});

describe('moneyFormatter', () => {
  it('falls back to the code beside the amount for a currency Intl refuses', () => {
    // `length(3)` is not a currency-code check, so rows carrying "$$$" predate
    // the fix that added one. A throw here unmounts to the error boundary and
    // takes the page down over a single cell.
    const format = moneyFormatter('$$$');
    expect(format(1234.5)).toBe(
      `$$$ ${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.5)}`,
    );
  });

  it('keeps the caller’s fraction digits in the fallback instead of forcing two', () => {
    // Merging a default `minimumFractionDigits: 2` under a caller's
    // `maximumFractionDigits: 0` gives min > max, which is itself a RangeError
    // — the fallback would throw exactly where it exists to stop throwing.
    const whole = moneyFormatter('$$$', { maximumFractionDigits: 0 });
    expect(() => whole(1234.5)).not.toThrow();
    expect(whole(1234.5)).not.toContain('.');

    const pinnedMin = moneyFormatter('123', { minimumFractionDigits: 4 });
    expect(pinnedMin(2)).toContain('2.0000');
  });

  it('defaults an absent currency to USD rather than failing', () => {
    expect(moneyFormatter(null)(5)).toBe(moneyFormatter('USD')(5));
    expect(moneyFormatter('')(5)).toBe(moneyFormatter('USD')(5));
    expect(moneyFormatter(undefined)(5)).toBe(moneyFormatter('USD')(5));
  });
});

describe('displayName / initials', () => {
  it('falls back to the email when there is no name on the row', () => {
    const u = { first_name: null, last_name: null, email: 'ada@example.com' };
    expect(displayName(u)).toBe('ada@example.com');
    expect(initials(u)).toBe('A');
  });

  it('uses whichever half of the name is present', () => {
    expect(displayName({ first_name: 'Ada', last_name: null, email: 'a@b.c' })).toBe('Ada');
    expect(displayName({ first_name: null, last_name: 'Lovelace', email: 'a@b.c' })).toBe('Lovelace');
    expect(initials({ first_name: 'Ada', last_name: null, email: 'a@b.c' })).toBe('A');
    expect(initials({ first_name: 'Ada', last_name: 'Lovelace', email: 'a@b.c' })).toBe('AL');
    // Only a surname: the first slot falls back to the email, so the avatar
    // reads "AL" rather than dropping to a single letter.
    expect(initials({ first_name: null, last_name: 'Lovelace', email: 'ada@b.c' })).toBe('AL');
  });

  it('answers a row with neither name nor email with a placeholder, not a crash', () => {
    // An invited-but-unregistered principal can reach a list with both columns
    // blank; `''[0]` is undefined, and `undefined + ''` would render "undefined".
    expect(initials({ first_name: null, last_name: null, email: '' })).toBe('?');
    expect(displayName({ first_name: null, last_name: null, email: '' })).toBe('');
  });
});

describe('eventLabel', () => {
  it('uses the written label when the type is one it knows', () => {
    expect(eventLabel('valuation_created')).not.toBe('valuation created');
  });

  it('makes an unknown type read as English rather than as a column value', () => {
    // The services add event types faster than this table is updated, and the
    // audit trail is append-only — so a type this build has never heard of is
    // the expected case, not a corrupt row.
    expect(eventLabel('some_future.event_type')).toBe('Some future event type');
    expect(eventLabel('singleword')).toBe('Singleword');
  });

  it('returns the type unchanged when there is nothing left to title-case', () => {
    // A separator-only type would otherwise render as an empty cell.
    expect(eventLabel('__')).toBe('__');
    expect(eventLabel('.')).toBe('.');
    expect(eventLabel('')).toBe('');
  });
});
