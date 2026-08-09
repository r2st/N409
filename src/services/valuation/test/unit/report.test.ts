import { describe, expect, it } from 'vitest';
import {
  fillTemplateVars,
  instantiateTemplate,
  REPORT_TEMPLATES,
  sanitizeContent,
  sanitizeHtml,
  templateForKind,
  visibleSections,
} from '../../src/domain/report.js';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';

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

  it('round-trips a hidden section, and omits the key when it is not hidden', () => {
    const content = sanitizeContent({
      title: 'T',
      sections: [
        { key: 'asc718', heading: 'ASC 718', html: '<p>a</p>', hidden: true },
        { key: 'conclusion', heading: 'Conclusion', html: '<p>b</p>' },
        // An explicit `false` normalises away: a report nobody has hidden
        // anything in should not grow a key per chapter in its stored jsonb.
        { key: 'dloc', heading: 'DLOC', html: '<p>c</p>', hidden: false },
      ],
    });
    expect(content.sections[0]!.hidden).toBe(true);
    expect(Object.hasOwn(content.sections[1]!, 'hidden')).toBe(false);
    expect(Object.hasOwn(content.sections[2]!, 'hidden')).toBe(false);
  });

  it('keeps the hidden section in storage but out of the rendered list', () => {
    // Hidden, not deleted — the whole point is that unhiding restores what was
    // written rather than the skeleton, so the text has to survive the save.
    const content = sanitizeContent({
      title: 'T',
      sections: [
        { key: 'a', heading: 'A', html: '<p>keep</p>' },
        { key: 'b', heading: 'B', html: '<p>authored, then hidden</p>', hidden: true },
        { key: 'c', heading: 'C', html: '<p>keep</p>' },
      ],
    });
    expect(content.sections).toHaveLength(3);
    expect(content.sections[1]!.html).toBe('<p>authored, then hidden</p>');
    expect(visibleSections(content).map((s) => s.key)).toEqual(['a', 'c']);
  });
});

describe('visibleSections', () => {
  const VARS = {
    company_name: 'Northwind Robotics, Inc.',
    kind: '409a' as const,
    valuation_ref: 'VAL-1777',
    date: '2026-06-30',
    currency: 'USD',
  };

  it('is the identity on a report with nothing hidden', () => {
    const body = instantiateTemplate(templateForKind('409a'), VARS);
    expect(visibleSections(body)).toHaveLength(body.sections.length);
  });

  it('leaves no gap in what the renderer receives', () => {
    /*
     * The numbering, the table of contents, the bookmarks and the running heads
     * are all derived from this list, so a hidden chapter has to be absent from
     * it rather than present-and-blank. An empty chapter under a numbered
     * heading reads as an omission, which is the defect the toggle exists to
     * avoid — a gap in the numbering would be the same omission, differently
     * spelled.
     */
    const body = instantiateTemplate(templateForKind('409a'), VARS);
    const hide = new Set(['asset_approach', 'asc718']);
    const withHidden = {
      ...body,
      sections: body.sections.map((s) => (hide.has(s.key) ? { ...s, hidden: true } : s)),
    };
    const rendered = visibleSections(withHidden);
    expect(rendered).toHaveLength(body.sections.length - 2);
    for (const key of hide) expect(rendered.some((s) => s.key === key)).toBe(false);
    // Order is otherwise untouched: filtering, not re-sorting.
    expect(rendered.map((s) => s.key)).toEqual(
      body.sections.filter((s) => !hide.has(s.key)).map((s) => s.key),
    );
  });
});

describe('sanitizeHtml, continued', () => {
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
  it('registers the 409a.v58 and generic templates', () => {
    expect(REPORT_TEMPLATES.has('409a.v58')).toBe(true);
    expect(REPORT_TEMPLATES.has('generic.v2')).toBe(true);
  });

  it('selects 409a.v58 for 409a and a measurement skeleton for fund and debt', () => {
    expect(templateForKind('409a').version).toBe('409a.v58');
    // Both were on generic.v2 until 0109 connected an engagement to the
    // portfolio / instrument its figures live in — see domain/navExhibits.ts.
    expect(templateForKind('fund').version).toBe('fund.v1');
    expect(templateForKind('debt').version).toBe('debt.v1');
  });

  it('leaves no kind on the generic skeleton', () => {
    // The generic template stays registered as the fallback for a template
    // version stored on an older report, but nothing selects it any more: a
    // kind reaching it would be a report type shipped without a skeleton.
    for (const kind of VALUATION_KINDS) {
      expect(templateForKind(kind).version).not.toBe('generic.v2');
    }
  });

  it('selects a dedicated skeleton for each specialty report type', () => {
    expect(templateForKind('qsbs').version).toBe('qsbs.v2');
    expect(templateForKind('ppa').version).toBe('ppa.v2');
    expect(templateForKind('goodwill').version).toBe('impairment.v2');
    expect(templateForKind('esop').version).toBe('esop.v2');
    expect(templateForKind('fmv').version).toBe('smb.v2');
    expect(templateForKind('emi').version).toBe('emi.v2');
    expect(templateForKind('csop').version).toBe('csop.v2');
    expect(templateForKind('ip').version).toBe('ip.v2');
    expect(templateForKind('718').version).toBe('718.v2');
    expect(templateForKind('820').version).toBe('820.v2');
    expect(templateForKind('gifts').version).toBe('gifts.v2');
    expect(templateForKind('ifrs2').version).toBe('ifrs2.v2');
  });

  it('registers every specialty skeleton in the registry under its version', () => {
    for (const version of [
      'qsbs.v2',
      'ppa.v2',
      'impairment.v2',
      'esop.v2',
      'smb.v2',
      'emi.v2',
      'csop.v2',
      'ip.v2',
      '718.v2',
      '820.v2',
      'gifts.v2',
      'ifrs2.v2',
    ]) {
      expect(REPORT_TEMPLATES.has(version), version).toBe(true);
    }
  });

  it('carries the sections a reviewer of each accounting deliverable expects', () => {
    const keysOf = (kind: Parameters<typeof templateForKind>[0]) =>
      templateForKind(kind).sections.map((s) => s.key);
    expect(keysOf('718')).toEqual(
      expect.arrayContaining(['measurement_objective', 'model_and_assumptions', 'expense_recognition']),
    );
    expect(keysOf('820')).toEqual(
      expect.arrayContaining(['hierarchy', 'methodology', 'unobservable_inputs']),
    );
    expect(keysOf('gifts')).toEqual(
      expect.arrayContaining(['interest_description', 'discounts', 'chapter_14', 'adequate_disclosure']),
    );
    expect(keysOf('ifrs2')).toEqual(
      expect.arrayContaining(['measurement_principles', 'model_and_assumptions', 'expense_recognition']),
    );
  });

  it('carries the sections a reviewer of each specialty deliverable expects', () => {
    const keysOf = (kind: Parameters<typeof templateForKind>[0]) =>
      templateForKind(kind).sections.map((s) => s.key);
    expect(keysOf('qsbs')).toEqual(
      expect.arrayContaining([
        'gross_asset_test',
        'active_business_test',
        'issuance_and_holding',
        'exclusion_cap',
      ]),
    );
    expect(keysOf('ppa')).toEqual(
      expect.arrayContaining(['transaction_overview', 'intangible_assets', 'goodwill']),
    );
    expect(keysOf('goodwill')).toEqual(
      expect.arrayContaining(['reporting_units', 'qualitative_assessment', 'quantitative_tests']),
    );
    expect(keysOf('esop')).toEqual(expect.arrayContaining(['level_of_value', 'repurchase_obligation']));
    expect(keysOf('fmv')).toEqual(expect.arrayContaining(['earnings_normalization', 'valuation_methods']));
    expect(keysOf('emi')).toEqual(expect.arrayContaining(['umv_amv', 'scheme_limits']));
    expect(keysOf('csop')).toEqual(expect.arrayContaining(['scheme_limits']));
    expect(keysOf('ip')).toEqual(expect.arrayContaining(['asset_description', 'valuation_methods']));
  });

  it('instantiates a specialty skeleton with variables resolved', () => {
    const content = instantiateTemplate(templateForKind('qsbs'), {
      company_name: 'Acme',
      kind: 'qsbs',
      valuation_ref: 'VAL-42',
      date: '2026-08-07',
      currency: 'USD',
    });
    const intro = content.sections.find((s) => s.key === 'introduction');
    expect(intro?.html).toContain('Acme');
    expect(intro?.html).toContain('2026-08-07');
    expect(intro?.html).not.toContain('{{');
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

  /**
   * Closing-block parity. Before withClosingSections, only 409A and gifts
   * carried a certification: twelve report types went out as signed valuation
   * opinions with nothing after the conclusion. This is the guarantee that
   * cannot regress when a fourteenth report type is added.
   */
  it('closes every registered template with the same four sections', () => {
    for (const template of REPORT_TEMPLATES.values()) {
      const keys = new Set(template.sections.map((s) => s.key));
      for (const required of ['limiting_conditions', 'certification', 'qualifications', 'exhibit_index']) {
        expect(keys.has(required), `${template.version} is missing ${required}`).toBe(true);
      }
    }
  });

  it('closes every valuation kind, not just the ones in the registry', () => {
    for (const kind of VALUATION_KINDS) {
      const keys = new Set(templateForKind(kind).sections.map((s) => s.key));
      expect(keys.has('certification'), `${kind} has no certification page`).toBe(true);
      expect(keys.has('limiting_conditions'), `${kind} has no limiting conditions`).toBe(true);
    }
  });

  it('leaves a template that authored its own closing section alone', () => {
    // The shared block is a floor, not an override: 409A keeps its
    // §409A-specific certification and its enumerated Exhibit A–H index.
    const a409 = templateForKind('409a');
    expect(a409.sections.find((s) => s.key === 'certification')!.html).toContain(
      'No one provided significant professional assistance',
    );
    expect(a409.sections.find((s) => s.key === 'exhibit_index')!.html).toContain('Exhibit A');
    // A template that got the shared index instead does not claim exhibits it
    // may not have — the specialty schedules vary by engine and by run.
    expect(templateForKind('qsbs').sections.find((s) => s.key === 'exhibit_index')!.html).not.toContain(
      'Exhibit A',
    );
  });

  it('puts the certification after the conclusion, never before it', () => {
    for (const kind of VALUATION_KINDS) {
      const keys = templateForKind(kind).sections.map((s) => s.key);
      const conclusion = keys.indexOf('conclusion');
      if (conclusion === -1) continue;
      expect(keys.indexOf('certification'), kind).toBeGreaterThan(conclusion);
    }
  });

  it('names the company in the certification once instantiated', () => {
    const content = instantiateTemplate(templateForKind('esop'), {
      company_name: 'Acme Holdings',
      kind: 'esop',
      valuation_ref: 'ref',
      date: '2026-07-06',
      currency: 'USD',
    });
    const cert = content.sections.find((s) => s.key === 'certification');
    expect(cert?.html).toContain('Acme Holdings');
    expect(cert?.html).not.toContain('{{');
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
      'capital_structure',
      'economic_outlook',
      'methodology',
      'income_approach',
      'market_approach',
      'asset_approach',
      'reconciliation',
      'allocation',
      'dloc',
      'dlom',
      'conclusion',
      'limiting_conditions',
      'safe_harbor',
      'certification',
      'qualifications',
    ]) {
      expect(byKey.has(key), key).toBe(true);
    }

    // A discount the engine applies and the summary page prints has to be
    // supported in the prose too — an unexplained minority discount is the kind
    // of unsupported adjustment that costs a valuation its safe harbour.
    expect(byKey.get('dloc')!.html).toMatch(/minority/i);
    expect(byKey.get('dloc')!.html).toMatch(/control/i);

    // Rev. Rul. 59-60 §4.01(b) asks for the economic outlook, not only the
    // industry one.
    expect(byKey.get('economic_outlook')!.html).toMatch(/59-60/);

    // SSVS-1 requires the appraiser's credentials in the report itself.
    expect(byKey.get('qualifications')!.html).toMatch(/ABV|ASA|CFA|CVA/);

    // Each approach section points at the schedule carrying its figures.
    expect(byKey.get('income_approach')!.html).toContain('Exhibit C');
    expect(byKey.get('market_approach')!.html).toContain('Exhibit D');
    expect(byKey.get('reconciliation')!.html).toContain('Exhibit B');
    expect(byKey.get('allocation')!.html).toContain('Exhibit F');
    expect(byKey.get('capital_structure')!.html).toContain('Exhibit A');

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
    // The rights are described before the section that splits value on them.
    expect(at('capital_structure')).toBeLessThan(at('allocation'));
    // Each approach, then the weighting of their indications, then the
    // allocation of the weighted result.
    for (const approach of ['income_approach', 'market_approach', 'asset_approach']) {
      expect(at('methodology'), approach).toBeLessThan(at(approach));
      expect(at(approach), approach).toBeLessThan(at('reconciliation'));
    }
    expect(at('reconciliation')).toBeLessThan(at('allocation'));
    // Discounts apply to the allocated value, in the order the engine applies
    // them: DLOC, then DLOM.
    expect(at('allocation')).toBeLessThan(at('dloc'));
    expect(at('dloc')).toBeLessThan(at('dlom'));
    expect(at('dlom')).toBeLessThan(at('conclusion'));
    // The exhibit index is last, because the exhibits are appended after it.
    expect(at('exhibit_index')).toBe(keys.length - 1);
    expect(at('certification')).toBeLessThan(at('qualifications'));
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

  // A built-in skeleton is code-authored, but the variables merged into it are
  // not: company_name is free text the client types, and it lands inside
  // <strong>{{company_name}}</strong> in five sections of the 409A skeleton.
  // Filled raw, whatever was typed became stored report HTML on first ops
  // access — and the auditor portal renders stored section HTML directly, so
  // the payload executed in the browser of the external auditor reviewing the
  // engagement. The managed-template path already sanitized; this one did not.
  const XSS_NAME = '<img src=x onerror="alert(1)">Acme';

  const instantiate409a = (companyName: string) =>
    instantiateTemplate(templateForKind('409a'), {
      company_name: companyName,
      kind: '409a',
      valuation_ref: 'ref',
      date: '2026-07-06',
      currency: 'USD',
    });

  it('strips markup a company name smuggles into the body', () => {
    const content = instantiate409a(XSS_NAME);
    // The name appears in several sections; none may carry the payload.
    const carrying = content.sections.filter((s) => /<img|onerror/i.test(s.html));
    expect(carrying).toEqual([]);
    // The harmless part of the name still reads through.
    expect(content.sections.some((s) => s.html.includes('Acme'))).toBe(true);
  });

  it('leaves a filled skeleton at its sanitizer fixed point for every var', () => {
    for (const name of [XSS_NAME, '<script>alert(1)</script>', 'A & B, Ltd.', 'Acme']) {
      for (const section of instantiate409a(name).sections) {
        expect(sanitizeHtml(section.html), name).toBe(section.html);
      }
    }
  });

  it('keeps the placeholders an ordinary company name resolves to', () => {
    // Sanitising the body must not cost the substitution itself.
    const content = instantiate409a('Acme Robotics, Inc.');
    const intro = content.sections[0]!;
    expect(intro.html).toContain('Acme Robotics, Inc.');
    expect(intro.html).toContain('2026-07-06');
    expect(intro.html).not.toContain('{{');
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

/**
 * Input shapes that used to make the sanitizer quadratic.
 *
 * Both regexes it was built from ended in `[^>]*>`, so on input with no `>` in
 * it the engine ran to the end of the document from every `<`, failed,
 * backtracked the whole way, and started again one character along. 12.5k
 * characters of `"<p"` cost 36ms, 25k 140ms, 50k 567ms and 100k 2.27s — a clean
 * 4x per doubling — against 3ms for ordinary editor HTML of the same size, with
 * 100,000 the per-section limit `reports.ts` already allows.
 *
 * The budgets below are set an order of magnitude under the quadratic timings
 * and two orders above what the scan needs, so they fail on a return of the
 * exponent rather than on a slow machine.
 */
describe('sanitizeHtml on input with no closing bracket', () => {
  const SECTION_LIMIT = 100_000;
  const elapsed = (fn: () => unknown): number => {
    const started = Date.now();
    fn();
    return Date.now() - started;
  };

  it('sanitizes a section-sized run of unterminated tags in linear time', () => {
    expect(elapsed(() => sanitizeHtml('<p'.repeat(SECTION_LIMIT / 2)))).toBeLessThan(500);
  });

  it('sanitizes a section-sized run of junk leads in linear time', () => {
    // `"<3"` exercises the second regex, the junk-tag sweep, which was
    // quadratic in exactly the same way and by exactly the same amount.
    expect(elapsed(() => sanitizeHtml('<3'.repeat(SECTION_LIMIT / 2)))).toBeLessThan(500);
  });

  it('scales linearly rather than quadratically as the input doubles', () => {
    const cost = (n: number) => elapsed(() => sanitizeHtml('<p'.repeat(n)));
    cost(2_000); // warm up so the first measurement is not paying for JIT
    expect(cost(50_000)).toBeLessThan(Math.max(cost(12_500), 5) * 8);
  });

  it('keeps the text of an unterminated tag rather than eating the rest', () => {
    expect(sanitizeHtml('<p>kept</p><p')).toBe('<p>kept</p><p');
    expect(sanitizeHtml('5 < 6')).toBe('5 < 6');
  });

  it('leaves a bare "<>" alone — it was never a junk tag', () => {
    expect(sanitizeHtml('text<><')).toBe('text<><');
    expect(sanitizeHtml('><>')).toBe('><>');
  });

  it('keeps text in front of a dropped tag when the "<" before it never closed', () => {
    // The junk sweep runs over what the whitelist pass *left*: the `>` that
    // would have closed `<3` was consumed with the `<img>`, so `<3` is text.
    expect(sanitizeHtml('<3<img src=x onerror=y>')).toBe('<3');
    expect(sanitizeHtml('<3<svg>')).toBe('<3');
  });

  it('still strips everything it stripped before', () => {
    expect(sanitizeHtml('<p>ok</p><script>alert(1)</script>')).toBe('<p>ok</p>');
    expect(sanitizeHtml('<img src=x onerror=alert(1)>text')).toBe('text');
    expect(sanitizeHtml('<3 onerror=alert(1)>text')).toBe('text');
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="https://ok.example">x</a>')).toBe('<a href="https://ok.example">x</a>');
    expect(sanitizeHtml('<p onclick="boom()">x</p>')).toBe('<p>x</p>');
  });
});

describe('fillTemplateVars', () => {
  const VARS = {
    company_name: 'Acme',
    kind: '409a' as const,
    valuation_ref: 'ref',
    date: '2026-07-06',
    currency: 'USD',
  };

  it('substitutes known placeholders and leaves unknown ones verbatim', () => {
    expect(fillTemplateVars('{{company_name}} ({{kind}}) {{nope}}', VARS)).toBe('Acme (409a) {{nope}}');
  });

  /**
   * A sentence ending on a name that already ends in a full stop keeps one.
   *
   * `{{company_name}}.` is how the skeletons end a sentence, and most US
   * companies are called "…, Inc." — so the 409A shipped sentences reading
   * "the corresponding metric of Northwind Robotics, Inc.." on a page a board
   * reads. There is no phrasing of the template that is right for both "Inc."
   * and "Robotics", which is why this is handled at substitution.
   */
  describe('a name that ends in a full stop', () => {
    const fill = (name: string) =>
      fillTemplateVars('the metric of {{company_name}}.', { ...VARS, company_name: name });

    it('does not double the stop', () => {
      expect(fill('Northwind Robotics, Inc.')).toBe('the metric of Northwind Robotics, Inc.');
      expect(fill('Widgets Ltd.')).toBe('the metric of Widgets Ltd.');
    });

    it('still ends the sentence for a name that does not', () => {
      expect(fill('Northwind Robotics')).toBe('the metric of Northwind Robotics.');
      expect(fill('Acme LLC')).toBe('the metric of Acme LLC.');
    });

    it('leaves an ellipsis alone, so the readiness gate still finds it', () => {
      // `reportReadiness` reads `...` as a figure the analyst never supplied.
      // Absorbing one of the three would hide the marker it looks for.
      expect(fillTemplateVars('is {{company_name}}...', { ...VARS, company_name: 'Acme Inc.' })).toBe(
        'is Acme Inc....',
      );
    });

    it('leaves the stop attached to a placeholder it did not fill', () => {
      expect(fillTemplateVars('of {{nope}}.', VARS)).toBe('of {{nope}}.');
    });
  });

  // `\w+` matches every name on `Object.prototype`, and a plain `vars[key]`
  // lookup found them — so `{{constructor}}` in a report template rendered as
  // `function Object() { [native code] }` into the report body, which the
  // auditor portal then shows. Same three lines as `renderTemplate` in
  // domain/communications.ts, which carries the full note.
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'leaves the inherited name {{%s}} verbatim',
    (key) => {
      expect(fillTemplateVars(`{{${key}}}`, VARS)).toBe(`{{${key}}}`);
    },
  );

  it('keeps an inherited name out of an instantiated template body', () => {
    const content = instantiateTemplate(templateForKind('409a'), {
      ...VARS,
      company_name: '{{constructor}}',
    });
    for (const section of content.sections) {
      expect(section.html, section.key).not.toContain('native code');
    }
  });
});
