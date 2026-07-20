import { describe, expect, it } from 'vitest';
import {
  instantiateTemplate,
  REPORT_TEMPLATES,
  sanitizeContent,
  sanitizeHtml,
  templateForKind,
} from '../../src/domain/report.js';

describe('sanitizeHtml', () => {
  it('keeps whitelisted structure and drops all attributes', () => {
    expect(sanitizeHtml('<p class="x" style="color:red" onclick="evil()">Hi <strong data-a="1">there</strong></p>')).toBe(
      '<p>Hi <strong>there</strong></p>',
    );
  });

  it('removes script/style elements including their content', () => {
    expect(sanitizeHtml('<p>ok</p><script>alert(1)</script><style>p{}</style>')).toBe('<p>ok</p>');
    expect(sanitizeHtml('<SCRIPT SRC="x">boom()</SCRIPT>safe')).toBe('safe');
  });

  it('drops non-whitelisted tags but keeps their text', () => {
    expect(sanitizeHtml('<div><span>text</span></div>')).toBe('text');
    expect(sanitizeHtml('<img src=x onerror=alert(1)>after')).toBe('after');
    // links are whitelisted since gap 9 — unsafe schemes lose only the href
    expect(sanitizeHtml('<a href="javascript:x">link</a>')).toBe('<a>link</a>');
    expect(sanitizeHtml('<iframe src="https://evil.example"></iframe>')).toBe('');
  });

  it('normalizes br and strips comments', () => {
    expect(sanitizeHtml('a<br/>b<!-- hidden -->c')).toBe('a<br>bc');
  });

  it('keeps tables and lists intact', () => {
    const html = '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><ul><li>x</li></ul>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('sanitizeContent applies to every section', () => {
    const content = sanitizeContent({
      title: 'T',
      sections: [{ key: 's1', heading: 'H', html: '<p onmouseover="x">a</p>' }],
    });
    expect(content.sections[0]!.html).toBe('<p>a</p>');
  });
});

describe('report templates', () => {
  it('registers the 409a.v53 and generic templates', () => {
    expect(REPORT_TEMPLATES.has('409a.v53')).toBe(true);
    expect(REPORT_TEMPLATES.has('generic.v1')).toBe(true);
  });

  it('selects 409a.v53 for 409a and generic for every other kind', () => {
    expect(templateForKind('409a').version).toBe('409a.v53');
    expect(templateForKind('gifts').version).toBe('generic.v1');
    expect(templateForKind('718').version).toBe('generic.v1');
  });

  it('instantiates with placeholders resolved', () => {
    const content = instantiateTemplate(templateForKind('409a'), {
      company_name: 'Acme Robotics, Inc.',
      kind: '409a',
      valuation_ref: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      date: '2026-07-06',
      currency: 'USD',
    });
    expect(content.title).toContain('Acme Robotics, Inc.');
    expect(content.sections.length).toBeGreaterThanOrEqual(8);
    const intro = content.sections[0]!;
    expect(intro.html).toContain('Acme Robotics, Inc.');
    expect(intro.html).toContain('2026-07-06');
    expect(intro.html).toContain('01JZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(intro.html).not.toContain('{{');
  });

  it('includes an ASC 718 stock-based-compensation section in the 409A template', () => {
    const content = instantiateTemplate(templateForKind('409a'), {
      company_name: 'Acme',
      kind: '409a',
      valuation_ref: 'ref',
      date: '2026-07-06',
      currency: 'USD',
    });
    const asc718 = content.sections.find((s) => s.key === 'asc718');
    expect(asc718).toBeDefined();
    expect(asc718!.heading).toMatch(/ASC 718/);
    expect(asc718!.html).toMatch(/Black-Scholes-Merton/);
    expect(asc718!.html).toMatch(/straight-line/);
    expect(asc718!.html).toContain('<table>');
  });

  it('produces template HTML that survives its own sanitizer unchanged', () => {
    for (const template of REPORT_TEMPLATES.values()) {
      const content = instantiateTemplate(template, {
        company_name: 'X',
        kind: '409a',
        valuation_ref: 'ref',
        date: '2026-01-01',
        currency: 'USD',
      });
      for (const section of content.sections) {
        expect(sanitizeHtml(section.html)).toBe(section.html);
      }
    }
  });
});
