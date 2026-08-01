import { describe, expect, it } from 'vitest';
import { formatWorkbookValue, sanitizeHtml, REPORT_VISIBLE_STATES } from '../src/lib/m2';

describe('sanitizeHtml (client mirror)', () => {
  it('keeps whitelisted tags and strips attributes', () => {
    expect(sanitizeHtml('<p style="x" onclick="evil()">a <strong class="y">b</strong></p>')).toBe(
      '<p>a <strong>b</strong></p>',
    );
  });

  it('removes script/style with content and drops unknown tags', () => {
    expect(sanitizeHtml('<script>alert(1)</script><div>text</div>')).toBe('text');
    expect(sanitizeHtml('<img src=x onerror=alert(1)>ok')).toBe('ok');
  });

  it('normalizes br', () => {
    expect(sanitizeHtml('a<br />b')).toBe('a<br>b');
  });
});

describe('formatWorkbookValue', () => {
  it('formats currency, number, percent and null', () => {
    expect(formatWorkbookValue(null, 'currency')).toBe('—');
    expect(formatWorkbookValue(5100000, 'currency')).toBe(
      (5100000).toLocaleString(undefined, { maximumFractionDigits: 0 }),
    );
    expect(formatWorkbookValue(0.6667, 'percent')).toBe(
      `${(66.67).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`,
    );
    expect(formatWorkbookValue(6.5, 'number')).toBe(
      (6.5).toLocaleString(undefined, { maximumFractionDigits: 2 }),
    );
  });
});

describe('REPORT_VISIBLE_STATES', () => {
  it('matches the server policy states', () => {
    expect([...REPORT_VISIBLE_STATES].sort()).toEqual(['draft_accepted', 'drafted', 'published']);
  });
});
