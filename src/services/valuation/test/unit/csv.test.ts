import { describe, expect, it } from 'vitest';
import { parseCsvSheet } from '../../src/domain/capTable.js';
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

  // The other control character OWASP names, and the one this guard missed.
  // Quoting is not the defence: `"\r=cmd|'/c calc'!A1"` is a well-formed
  // quoted field, and the spreadsheet unquotes it, strips the leading CR, and
  // reads what is left as a formula — so the value used to clear both halves
  // of csvEscape with nothing added to it.
  it('guards against CR- and LF-prefixed formula injection', () => {
    expect(csvEscape('\r=SUM(A1)')).toBe('"\'\r=SUM(A1)"');
    expect(csvEscape("\r=cmd|'/c calc'!A1")).toBe("\"'\r=cmd|'/c calc'!A1\"");
    expect(csvEscape('\n=SUM(A1)')).toBe('"\'\n=SUM(A1)"');
    expect(csvEscape('\r\n@cmd')).toBe('"\'\r\n@cmd"');
  });

  it('leaves a CR in the middle of a value quoted but unprefixed', () => {
    // Only the *leading* character decides whether a cell is a formula, so an
    // ordinary multi-line note is not treated as an attack.
    expect(csvEscape('Board note\r\nApproved')).toBe('"Board note\r\nApproved"');
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
    // The leading BOM is asserted on its own below; this is about the rows.
    expect(csv.replace(/^\ufeff/, '')).toBe('id,name\r\n1,"Acme, Inc."\r\n2,\r\n');
  });
});

/**
 * A byte-order mark, so Excel reads the file as UTF-8.
 *
 * Every CSV this codebase produces is an `attachment` download or a member of
 * the evidence bundle — a file a human opens in a spreadsheet, never an API
 * payload. `charset=utf-8` on the response settles how a *browser* displays it
 * and has no bearing on what Excel does with the saved file: absent a BOM,
 * Excel decodes it in the system codepage, and "Ångström Robotics AB" arrives
 * as "Ã…ngstrÃ¶m Robotics AB" in the file an auditor reads. Company names,
 * analyst names and the free text in a change log are all reachable.
 *
 * That Excel is a first-class consumer here is not a guess: `domain/capTable.ts`
 * strips a leading BOM on *import* precisely because Excel's "Save as CSV UTF-8"
 * writes one — so this also makes an export round-trip back into the platform.
 */
describe('the byte-order mark on an exported file', () => {
  it('leads the file, before the header row', () => {
    const out = toCsv(['name'], [{ name: 'Ångström Robotics AB' }]);
    expect(out.startsWith('﻿')).toBe(true);
    expect(out.slice(1).startsWith('name\r\n')).toBe(true);
  });

  it('appears exactly once, however many rows there are', () => {
    const out = toCsv(['name'], [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    expect([...out].filter((ch) => ch === '﻿')).toHaveLength(1);
  });

  it('leaves the non-ASCII payload itself untouched', () => {
    const name = '北京机器人 — Ångström «Robotics» 🤖';
    const out = toCsv(['name'], [{ name }]);
    expect(out).toContain(name);
  });

  /**
   * Round-tripped through the real importer rather than a regex: the claim is
   * that `parseCsvSheet` — the parser every cap-table upload goes through —
   * reads an export of ours back, header names intact. A BOM left in place
   * becomes part of the first header name, which matches no column and is
   * exactly the failure that parser's own BOM strip exists to prevent.
   */
  it('is stripped by the importer, so an export reads straight back in', () => {
    const out = toCsv(
      ['Security Class', 'Shares'],
      [{ 'Security Class': 'Ångström Preferred «A»', Shares: '1,000' }],
    );
    const { headers, rows } = parseCsvSheet(out);
    expect(headers[0]).toBe('Security Class');
    expect(rows[0]!['Security Class']).toBe('Ångström Preferred «A»');
  });
});
