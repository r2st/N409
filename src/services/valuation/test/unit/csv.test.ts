import { describe, expect, it } from 'vitest';
import { csvEscape, toCsv } from '../../src/domain/csv.js';

describe('csvEscape', () => {
  it('passes plain values through', () => {
    expect(csvEscape('Acme')).toBe('Acme');
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape(true)).toBe('true');
  });

  it('renders null/undefined as empty', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('quotes commas, quotes and newlines', () => {
    expect(csvEscape('Acme, Inc.')).toBe('"Acme, Inc."');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('a\nb')).toBe('"a\nb"');
  });

  it('serialises dates as ISO and arrays with semicolons', () => {
    expect(csvEscape(new Date('2026-07-06T00:00:00Z'))).toBe('2026-07-06T00:00:00.000Z');
    expect(csvEscape(['US', 'GB'])).toBe('US;GB');
  });

  it('guards against spreadsheet formula injection', () => {
    expect(csvEscape('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvEscape('+1234')).toBe("'+1234");
    expect(csvEscape('@cmd')).toBe("'@cmd");
  });

  it('guards against tab-prefixed formula injection (OWASP CSV)', () => {
    expect(csvEscape('\t=SUM(A1)')).toBe("'\t=SUM(A1)");
    expect(csvEscape('\t+cmd|...')).toBe("'\t+cmd|...");
  });

  // A leading `-` is the one injection prefix that is also an ordinary value.
  // Prefixing it does not produce a cell a spreadsheet reads as the number: an
  // apostrophe is only a text marker when typed, so an imported CSV shows
  // `'-1200000` literally and holds it as text. Pre-revenue EBITDA and net
  // income are negative, and the audit change log exports both, from and to.
  describe('negative numbers', () => {
    it('passes plain negative numbers through unprefixed', () => {
      expect(csvEscape(-1200000)).toBe('-1200000');
      expect(csvEscape(-0.15)).toBe('-0.15');
      expect(csvEscape('-42')).toBe('-42');
      expect(csvEscape(-1.5e-7)).toBe('-1.5e-7');
    });

    it('still guards a leading `-` that is not just a number', () => {
      // The DDE payload: it starts with a digit-looking expression and is a
      // formula all the same.
      expect(csvEscape("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
      expect(csvEscape('-1-2')).toBe("'-1-2");
      expect(csvEscape('-SUM(A1)')).toBe("'-SUM(A1)");
      expect(csvEscape('--1')).toBe("'--1");
      expect(csvEscape('-')).toBe("'-");
    });

    it('leaves the other injection prefixes guarded', () => {
      expect(csvEscape('+1234')).toBe("'+1234");
      expect(csvEscape('=1')).toBe("'=1");
    });
  });
});

describe('toCsv', () => {
  it('emits a header and CRLF-joined rows in column order', () => {
    const csv = toCsv(
      ['id', 'name'],
      [
        { id: 1, name: 'Acme, Inc.' },
        { id: 2, name: null },
      ],
    );
    expect(csv).toBe('id,name\r\n1,"Acme, Inc."\r\n2,\r\n');
  });
});
