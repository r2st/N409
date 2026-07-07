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

  it('renders a header row and CRLF line endings', () => {
    const csv = toCsv(['a', 'b'], [['1', 'x,y']]);
    expect(csv).toBe('a,b\r\n1,"x,y"\r\n');
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
});
