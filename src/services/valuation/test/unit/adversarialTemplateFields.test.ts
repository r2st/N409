import { describe, expect, it } from 'vitest';
import {
  escapeTemplateVars,
  fillTemplateVars,
  instantiateTemplate,
  sanitizeHtml,
  templateForKind,
  visibleSections,
} from '../../src/domain/report.js';
import { fillFigures } from '../../src/domain/reportFigures.js';
import { renderTemplate } from '../../src/domain/communications.js';
import { renderEmailTemplate } from '../../src/domain/emailWorkflows.js';
import { escapeHtml, renderHtmlEmail, textToHtml } from '../../src/email/mime.js';

const vars = (companyName: string) =>
  ({
    company_name: companyName,
    kind: '409a',
    valuation_ref: '409A-1',
    date: '2026-01-01',
    currency: 'USD',
  }) as never;

/**
 * Round 182, methodology M6: a template variable whose *value* is hostile to
 * the template syntax it is substituted into.
 *
 * The HTML half of this was closed before (test/unit/reportAdversarialNames.ts:
 * a name is escaped, not sanitized, so `A & B <Holdings> Ltd` survives and
 * `<img onerror=…>` does not execute). What nothing looked at is the *brace*:
 * a report body is filled twice by one function at two different times, and a
 * value substituted in the first pass is ordinary text to the second.
 */
describe('a template variable that spells a marker', () => {
  /**
   * The finding. `company_name` is free text a client types, it is substituted
   * into eleven sections at draft time, and the stored result is filled again
   * from the calculation at render — so a name spelling `{{fmv_per_share}}`
   * put a live figure marker in the deliverable's identifying sentence.
   */
  it('cannot plant a render-time figure marker in the stored body', () => {
    const content = instantiateTemplate(templateForKind('409a'), vars('{{fmv_per_share}} Holdings'));
    const sections = visibleSections(content);
    const naming = sections.filter((s) => s.html.includes('Holdings'));
    expect(naming.length).toBeGreaterThan(0);

    for (const section of naming) {
      // Scoped to the name: the skeleton's *own* `{{fmv_per_share}}` is a real
      // marker and must survive — that is the second pass's whole job.
      expect(section.html).toContain('{fmv_per_share} Holdings');
      expect(section.html).not.toContain('{{fmv_per_share}} Holdings');
    }

    // And the render pass leaves it alone, which is the thing that broke: it
    // used to rewrite the company's name into the number.
    const rendered = fillFigures(content, { fmv_per_share: '$4.7100' } as never);
    for (const section of visibleSections(rendered).filter((s) => s.html.includes('Holdings'))) {
      expect(section.html).toContain('{fmv_per_share} Holdings');
      expect(section.html).not.toContain('$4.7100 Holdings');
    }
  });

  /**
   * The quieter direction. A marker that is not a figure survives both passes,
   * and `reportReadiness` reads a surviving marker as a figure the calculation
   * failed to supply — so the report is held back for a reason that is not true.
   */
  it('cannot plant a marker that no pass will ever fill', () => {
    const content = instantiateTemplate(templateForKind('409a'), vars('{{net_income}} Ltd'));
    const body = visibleSections(content)
      .map((s) => s.html)
      .join('');
    expect(body).toContain('{net_income} Ltd');
    // `net_income` is not a figure name, so nothing else in the skeleton spells
    // it: any doubled brace around it came from the name.
    expect(body).not.toContain('{{net_income}}');
  });

  /**
   * The title was built by interpolation rather than by the fill — the one path
   * that skipped the defang — and `fillFigures` fills `content.title` at render
   * like everything else, so the deliverable's own title was substitutable.
   */
  it('defangs in the title, which was assembled by a different route', () => {
    const content = instantiateTemplate(templateForKind('409a'), vars('{{dlom}} Inc.'));
    expect(content.title).toBe('IRC 409A Valuation Report — {dlom} Inc.');
    expect(content.title).not.toContain('{{');

    const rendered = fillFigures(content, { dlom: '25.0%' } as never);
    expect(rendered.title).toBe(content.title);

    for (const heading of content.sections.map((s) => s.heading)) {
      expect(heading).not.toContain('{{dlom}}');
    }
  });

  it('leaves a single brace alone — it is not marker syntax', () => {
    expect(fillTemplateVars('{{a}}', { a: '{"json": true}' })).toBe('{"json": true}');
    expect(fillTemplateVars('{{a}}', { a: 'f(x) { return 1 }' })).toBe('f(x) { return 1 }');
  });

  it('leaves the template author’s own unresolved markers standing', () => {
    // The defang applies to substituted values, never to the template text: an
    // unknown marker surviving verbatim is how the second pass finds its work.
    expect(fillTemplateVars('a {{unknown}} b', { company_name: 'X' })).toBe('a {{unknown}} b');
    expect(fillTemplateVars('{{a}} {{b}}', { a: 'X', b: undefined })).toBe('X {{b}}');
  });
});

/**
 * The invariants that were already right, pinned because each is one edit away
 * from silently not being — and each is a way a value becomes syntax.
 */
describe('substitution does not re-read what it just wrote', () => {
  it('is a single pass: a value naming another variable is not expanded', () => {
    expect(renderTemplate('{{a}}', { a: '{{b}}', b: 'SECRET' })).toBe('{{b}}');
    expect(renderEmailTemplate('{{a}}', { a: '{{b}}', b: 'SECRET' } as never)).toBe('{{b}}');
  });

  it('is not recursive: a value naming itself terminates', () => {
    expect(renderTemplate('{{a}}', { a: '{{a}}' })).toBe('{{a}}');
    expect(fillTemplateVars('{{a}}', { a: '{{a}} {{a}}' })).toBe('{a} {a}');
  });

  /**
   * Every one of these fills uses a *function* replacer, so `$&` and friends in
   * a value are literal. A refactor to a string replacement would turn a
   * company name of `$&$&$&` into the whole matched marker, repeatedly, and
   * nothing else would notice.
   */
  it('treats a dollar-pattern in a value as text, not as a replacement pattern', () => {
    const payload = "$& $` $' $1 $$";
    expect(renderTemplate('{{a}}', { a: payload })).toBe(payload);
    expect(renderEmailTemplate('{{a}}', { a: payload } as never)).toBe(payload);
    expect(fillTemplateVars('{{a}}', { a: payload })).toBe(payload);
  });

  it('never resolves a name off Object.prototype', () => {
    const text = '{{constructor}} {{__proto__}} {{toString}} {{hasOwnProperty}}';
    expect(renderTemplate(text, {})).toBe(text);
    expect(fillTemplateVars(text, {})).toBe(text);
    expect(renderEmailTemplate(text, {} as never)).toBe(text);
  });

  it('distinguishes an absent variable from one whose value is empty', () => {
    expect(renderTemplate('[{{a}}]', {})).toBe('[{{a}}]');
    expect(renderTemplate('[{{a}}]', { a: null })).toBe('[{{a}}]');
    expect(renderTemplate('[{{a}}]', { a: undefined })).toBe('[{{a}}]');
    expect(renderTemplate('[{{a}}]', { a: '' })).toBe('[]');
    expect(renderTemplate('[{{a}}]', { a: 0 })).toBe('[0]');
  });
});

describe('a hostile value on its way into markup', () => {
  it('escapes once into the report body, and the sanitizer does not escape it again', () => {
    const filled = fillTemplateVars('<p>{{a}}</p>', escapeTemplateVars({ a: 'A & B <Holdings> "Ltd"' }));
    // Only the three characters that can change the shape of the markup: a
    // quote in text content cannot, and escaping it would spell the name out as
    // entities in the PDF for nothing.
    expect(filled).toBe('<p>A &amp; B &lt;Holdings&gt; "Ltd"</p>');
    expect(sanitizeHtml(filled)).toBe(filled);
  });

  it('keeps a name that is already spelled with entities distinguishable', () => {
    // A company literally named "&amp;" must render as "&amp;", so the second
    // escape is correct rather than a double-escape bug.
    const filled = fillTemplateVars('<p>{{a}}</p>', escapeTemplateVars({ a: '&amp;' }));
    expect(filled).toBe('<p>&amp;amp;</p>');
  });

  it('escapes a scripted value into the HTML half of an email', () => {
    const body = renderTemplate('Hi {{a}}', { a: '<script>alert(1)</script>' });
    // The stored outbox body is plain text and keeps what was typed…
    expect(body).toBe('Hi <script>alert(1)</script>');
    // …and the HTML alternative built from it does not execute it.
    const html = renderHtmlEmail({ subject: body, body });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain(escapeHtml('<script>alert(1)</script>'));
  });

  it('does not let a value break out of a linkified href', () => {
    const html = textToHtml('see https://n409.app/x?a=1&b="><script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('href="https://n409.app/x?a=1&amp;b=');
  });

  it('survives a value far longer than any layout expects', () => {
    const long = 'L'.repeat(50_000);
    const content = instantiateTemplate(templateForKind('409a'), vars(long));
    expect(content.sections.length).toBeGreaterThan(0);
    expect(visibleSections(content).some((s) => s.html.includes(long))).toBe(true);
    expect(renderHtmlEmail({ subject: long, body: long }).length).toBeGreaterThan(long.length);
  });
});
