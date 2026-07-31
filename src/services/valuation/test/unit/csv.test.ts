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
