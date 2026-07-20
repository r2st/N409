import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  renderBoardResolution,
  resolutionStatusFrom,
  type BoardSignoffStatus,
} from '../../src/domain/boardResolution.js';

describe('boardResolution', () => {
  const base = {
    companyName: 'Acme Inc.',
    valuationKind: '409a',
    valuationDate: '2026-03-15',
    fmvConclusion: 1.23,
    currency: 'USD',
    methodologySummary: 'OPM allocation with a Chaffee DLOM.',
    appraiserQualifications: 'Independent appraiser.',
    reference: '01HTESTREFERENCE0000000000',
  };

  it('renders the FMV, date and safe-harbor language into the body', () => {
    const html = renderBoardResolution(base);
    expect(html).toContain('Acme Inc.');
    expect(html).toContain('USD 1.23 per share');
    expect(html).toContain('March 15, 2026');
    expect(html).toContain('§1.409A-1(b)(5)(iv)(B)');
    expect(html).toContain('OPM allocation with a Chaffee DLOM.');
    expect(html).toContain('01HTESTREFERENCE0000000000');
  });

  it('trims trailing zeros but keeps meaningful cents', () => {
    expect(renderBoardResolution({ ...base, fmvConclusion: 2 })).toContain('USD 2 per share');
    expect(renderBoardResolution({ ...base, fmvConclusion: 2.5 })).toContain('USD 2.5 per share');
    expect(renderBoardResolution({ ...base, fmvConclusion: 0.0125 })).toContain('USD 0.0125 per share');
  });

  it('escapes HTML in company-supplied text', () => {
    const html = renderBoardResolution({ ...base, companyName: 'Evil <script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapeHtml handles the core entities', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  describe('resolutionStatusFrom', () => {
    const s = (status: BoardSignoffStatus) => ({ status });

    it('is pending with no members', () => {
      expect(resolutionStatusFrom([])).toBe('pending');
    });

    it('is pending while any member has not signed', () => {
      expect(resolutionStatusFrom([s('signed'), s('pending')])).toBe('pending');
    });

    it('is approved only when every member has signed', () => {
      expect(resolutionStatusFrom([s('signed'), s('signed')])).toBe('approved');
    });

    it('is rejected if any member rejects, regardless of others', () => {
      expect(resolutionStatusFrom([s('signed'), s('rejected'), s('pending')])).toBe('rejected');
    });
  });
});
