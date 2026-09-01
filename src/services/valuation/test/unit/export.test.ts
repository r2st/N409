import { describe, expect, it } from 'vitest';
import { csvField, toCsv } from '../../src/export/csv.js';
import { tablePdf } from '../../src/export/pdf.js';

describe('CSV export (M4)', () => {
  it('passes plain values through and stringifies dates as ISO', () => {
    expect(csvField('Acme')).toBe('Acme');
    expect(csvField(42)).toBe('42');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField(new Date('2026-07-06T00:00:00Z'))).toBe('2026-07-06T00:00:00.000Z');
  });

  it('quotes fields with commas, quotes, and newlines (RFC 4180)', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralizes spreadsheet formula injection', () => {
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('@cmd')).toBe("'@cmd");
    // and the quote-prefix still gets CSV-quoted when needed
    expect(csvField('=A1,B1')).toBe('"\'=A1,B1"');
  });

  it('leaves a negative number alone — the audit change log is full of them', () => {
    expect(csvField(-1200000)).toBe('-1200000');
    expect(csvField('-0.15')).toBe('-0.15');
    // The DDE vector still starts with '-' and is still neutralized.
    expect(csvField('-2+3+cmd|calc')).toBe("'-2+3+cmd|calc");
  });

  it('renders a header row and CRLF line endings', () => {
    const csv = toCsv(['a', 'b'], [['1', 'x,y']]);
    // Past the BOM, which csv.test.ts asserts separately.
    expect(csv.replace(/^\ufeff/, '')).toBe('a,b\r\n1,"x,y"\r\n');
  });
});

describe('PDF export (M4)', () => {
  const columns = [
    { header: 'Company', width: 200 },
    { header: 'State', width: 100 },
  ];

  it('produces a structurally valid PDF', () => {
    const pdf = tablePdf('Valuations', columns, [['Acme Corp', 'published']]);
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('(Acme Corp)');
  });

  it('escapes PDF string delimiters and paginates long tables', () => {
    const rows = Array.from({ length: 100 }, (_, i) => [`Row (${i}) \\ test`, 'pending']);
    const pdf = tablePdf('Big export', columns, rows);
    const text = pdf.toString('latin1');
    expect(text).toContain('Row \\(0\\) \\\\ te'); // escaped, possibly truncated
    const pageCount = (text.match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
    expect(text).toContain(`(Page 1 of ${pageCount})`);
  });

  it('replaces non-Latin-1 characters instead of corrupting the stream', () => {
    const pdf = tablePdf('Export', columns, [['Ünïcode ✓', 'ok']]);
    const text = pdf.toString('latin1');
    expect(text).toContain('(Ünïcode ?)');
  });

  /**
   * The offsets, over a document that actually contains the characters the test
   * above proves survive the escape.
   *
   * `Ünïcode` above is written and read back as latin1 and passes either way —
   * the bytes of the *string* were never the defect. The defect was that the
   * cross-reference table counted them in UTF-8 while the file was emitted in
   * latin1, so every offset after the first accented cell was too large by one
   * per character in U+0080..U+00FF. Two pages, so at least one object's offset
   * is recorded after the accented content rather than before it.
   */
  it('records byte offsets in the encoding the file is written in', () => {
    const accented = Array.from({ length: 60 }, (_, i) => [`Société Générale Café ${i}`, 'published']);
    const pdf = tablePdf('Rapport annuel — Société', columns, accented);
    const text = pdf.toString('latin1');

    // Every declared stream length is the real one.
    for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
      expect(Buffer.byteLength(m[2]!, 'latin1')).toBe(Number(m[1]));
    }

    // Every xref entry points at the object it claims, and startxref at `xref`.
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(4);
    offsets.forEach((off, i) => {
      expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    const xrefStart = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xrefStart, xrefStart + 4)).toBe('xref');
  });

  /**
   * Cost is linear in rows, and the assertion is a *ratio* rather than a
   * millisecond ceiling so it says the same thing on any box.
   *
   * `tablePdf` runs on the valuation service's event loop — there is no offload
   * for it, unlike the report renderer — so a 10,000-row export (the cap) is
   * time every other request in the process spends waiting. It used to call
   * `Buffer.byteLength` on the whole accumulated document once per object, 611
   * times on a full export, each re-encoding a rope that ends 2.8 MB long:
   * quadratic, 147 ms at the cap against 16 ms now. Four times the rows must
   * cost about four times the work; the old shape cost sixteen.
   */
  it('costs time linear in the number of rows', () => {
    const wide = Array.from({ length: 7 }, (_, i) => ({ header: `Column ${i}`, width: 100 }));
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => Array.from({ length: 7 }, (_, j) => `cell ${i}-${j} value`));
    const small = mk(2_000);
    const big = mk(8_000);
    const median = (run: () => void): number => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        run();
        samples.push(performance.now() - t0);
      }
      return samples.sort((a, b) => a - b)[2]!;
    };
    tablePdf('warm', wide, mk(200));
    const ratio = median(() => tablePdf('t', wide, big)) / median(() => tablePdf('t', wide, small));
    // Linear is 4; quadratic is 16. Halfway is a defect either way.
    expect(ratio).toBeLessThan(9);
  });
});
