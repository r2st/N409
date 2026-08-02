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
    expect(
      sanitizeHtml(
        '<p class="x" style="color:red" onclick="evil()">Hi <strong data-a="1">there</strong></p>',
      ),
    ).toBe('<p>Hi <strong>there</strong></p>');
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
    const html =
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><ul><li>x</li></ul>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('sanitizeContent applies to every section', () => {
    const content = sanitizeContent({
      title: 'T',
      sections: [{ key: 's1', heading: 'H', html: '<p onmouseover="x">a</p>' }],
    });
    expect(content.sections[0]!.html).toBe('<p>a</p>');
  });

  it('leaves an unterminated comment or raw-text element where it stands', () => {
    // No `-->` to be found: the marker is text from there on, and the tags
    // after it still face the whitelist.
    expect(sanitizeHtml('a<!--b<p>c')).toBe('a<!--b<p>c');
    // `<script>` with no `</script>`: the body is not a raw-text span, so the
    // open tag is dropped as a non-whitelisted tag and its text survives.
    expect(sanitizeHtml('<p>ok</p><script>alert(1)')).toBe('<p>ok</p>alert(1)');
    // A missing `</script>` says nothing about a `</style>` still to come.
    expect(sanitizeHtml('<script>a<style>b</style>c')).toBe('ac');
  });

  it('sanitizes markers that are never closed in linear time', () => {
    // A section is capped at 100,000 characters and a report takes 50 of them.
    // Under the lazy-regex sanitizer this body was quadratic — every `<!--` a
    // candidate start, each rescanning to the end before failing — and held
    // the event loop for tens of seconds on a single save. Well under a second
    // here; the ceiling is loose so a slow CI box does not flake it.
    for (const marker of ['<!--', '<script>', '<style>', '<h1>']) {
      const body = marker.repeat(Math.ceil((50 * 100_000) / marker.length));
      const started = performance.now();
      sanitizeHtml(body);
      expect(performance.now() - started).toBeLessThan(3_000);
    }
  });
});

describe('report templates', () => {
  it('registers the 409a.v54 and generic templates', () => {
    expect(REPORT_TEMPLATES.has('409a.v54')).toBe(true);
    expect(REPORT_TEMPLATES.has('generic.v1')).toBe(true);
  });

  it('selects 409a.v54 for 409a and generic for every other kind', () => {
    expect(templateForKind('409a').version).toBe('409a.v54');
    expect(templateForKind('gifts').version).toBe('generic.v1');
    expect(templateForKind('718').version).toBe('generic.v1');
  });

  it("keys the registry by each template's own version", () => {
    for (const [version, template] of REPORT_TEMPLATES) {
      expect(template.version).toBe(version);
    }
  });

  it('gives every section a unique key and a heading', () => {
    for (const template of REPORT_TEMPLATES.values()) {
      const keys = template.sections.map((s) => s.key);
      expect(new Set(keys).size, template.version).toBe(keys.length);
      for (const section of template.sections) {
        expect(section.heading.length, section.key).toBeGreaterThan(0);
        expect(section.html.length, section.key).toBeGreaterThan(0);
      }
    }
  });

  it('carries the sections an auditor reviewing a 409A expects to find', () => {
    const content = instantiateTemplate(templateForKind('409a'), {
      company_name: 'Acme',
      kind: '409a',
      valuation_ref: 'ref',
      date: '2026-07-06',
      currency: 'USD',
    });
    const byKey = new Map(content.sections.map((s) => [s.key, s]));
    for (const key of [
      'standard_of_value',
      'sources_of_information',
      'methodology',
      'conclusion',
      'limiting_conditions',
      'safe_harbor',
      'certification',
    ]) {
      expect(byKey.has(key), key).toBe(true);
    }

    // Rev. Rul. 59-60 fair market value and the going-concern premise.
    expect(byKey.get('standard_of_value')!.html).toMatch(/59-60/);
    expect(byKey.get('standard_of_value')!.html).toMatch(/going concern/i);

    // The safe harbor rests on the independent-appraiser presumption.
    expect(byKey.get('safe_harbor')!.html).toMatch(/1\.409A-1\(b\)\(5\)\(iv\)\(B\)\(1\)/);
    expect(byKey.get('safe_harbor')!.html).toMatch(/12 months/);

    // Certification must disclaim a contingent fee and any interest in the company.
    expect(byKey.get('certification')!.html).toMatch(/contingent/i);
    expect(byKey.get('certification')!.html).toContain('Acme');
  });

  it('orders the 409A skeleton so conclusions follow the analysis', () => {
    const keys = templateForKind('409a').sections.map((s) => s.key);
    const at = (key: string) => keys.indexOf(key);
    expect(at('introduction')).toBe(0);
    expect(at('sources_of_information')).toBeLessThan(at('financial_analysis'));
    expect(at('methodology')).toBeLessThan(at('conclusion'));
    expect(at('conclusion')).toBeLessThan(at('safe_harbor'));
    expect(at('certification')).toBe(keys.length - 1);
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
