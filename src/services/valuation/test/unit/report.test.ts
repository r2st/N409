import { describe, expect, it } from 'vitest';
import {
  EXHIBIT_INDEX_MARKER,
  fillTemplateVars,
  instantiateTemplate,
  REPORT_TEMPLATES,
  sanitizeContent,
  sanitizeHtml,
  templateForKind,
  visibleSections,
} from '../../src/domain/report.js';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';
import { expectSubQuadratic } from '../support/complexity.js';

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
    // Under the lazy-regex sanitizer this body was quadratic — every `<!--` a
    // candidate start, each rescanning to the end before failing — and held the
    // event loop for tens of seconds on a single save.
    //
    // This used to render fifty section-loads of each marker and assert a
    // three-second ceiling, which is the shape of timing test that eventually
    // fails on a busy machine rather than on a bug: 2.1s idle against a 3s
    // budget is a 1.4x margin, and it duly failed at 3.4s under load. What
    // matters is the exponent, so that is what is asserted now — four times the
    // input, not sixteen times the cost — over inputs small enough that neither
    // measurement outlives a scheduler slice.
    for (const marker of ['<!--', '<script>', '<style>', '<h1>']) {
      expectSubQuadratic({
        input: (chars) => marker.repeat(Math.ceil(chars / marker.length)),
        run: sanitizeHtml,
        size: 25_000,
      });
    }
  });
});

describe('report templates', () => {
  it('registers the 409a.v64 and generic templates', () => {
    expect(REPORT_TEMPLATES.has('409a.v64')).toBe(true);
    expect(REPORT_TEMPLATES.has('generic.v3')).toBe(true);
  });

  it('selects 409a.v64 for 409a and a measurement skeleton for fund and debt', () => {
    expect(templateForKind('409a').version).toBe('409a.v64');
    // Both were on generic.v2 (now v3) until 0109 connected an engagement to the
    // portfolio / instrument its figures live in — see domain/navExhibits.ts.
    expect(templateForKind('fund').version).toBe('fund.v2');
    expect(templateForKind('debt').version).toBe('debt.v2');
  });

  it('leaves no kind on the generic skeleton', () => {
    // The generic template stays registered as the fallback for a template
    // version stored on an older report, but nothing selects it any more: a
    // kind reaching it would be a report type shipped without a skeleton.
    for (const kind of VALUATION_KINDS) {
      expect(templateForKind(kind).version).not.toBe('generic.v3');
    }
  });

  it('selects a dedicated skeleton for each specialty report type', () => {
    expect(templateForKind('qsbs').version).toBe('qsbs.v4');
    expect(templateForKind('ppa').version).toBe('ppa.v3');
    expect(templateForKind('goodwill').version).toBe('impairment.v3');
    expect(templateForKind('esop').version).toBe('esop.v3');
    expect(templateForKind('fmv').version).toBe('smb.v3');
    expect(templateForKind('emi').version).toBe('emi.v3');
    expect(templateForKind('csop').version).toBe('csop.v3');
    expect(templateForKind('ip').version).toBe('ip.v3');
    expect(templateForKind('718').version).toBe('718.v3');
    expect(templateForKind('820').version).toBe('820.v3');
    expect(templateForKind('gifts').version).toBe('gifts.v3');
    expect(templateForKind('ifrs2').version).toBe('ifrs2.v3');
  });

  it('states both §1202 regimes in the QSBS skeleton, not just the pre-2025 one', () => {
    // P.L. 119-21 rewrote the gross-asset ceiling, the per-issuer cap and the
    // holding period for stock acquired after 4 July 2025, and left them for
    // everything before. The skeleton is the analyst's instruction sheet, so
    // naming only one set of figures is how the wrong statute gets written into
    // a client letter — the deliverable, not a screen.
    const byKey = new Map(templateForKind('qsbs').sections.map((s) => [s.key, s.html]));
    const assets = byKey.get('gross_asset_test')!;
    expect(assets).toContain('$50 million');
    expect(assets).toContain('$75 million');
    const holding = byKey.get('issuance_and_holding')!;
    expect(holding).toContain('five-year date');
    expect(holding).toContain('three years for 50%');
    const cap = byKey.get('exclusion_cap')!;
    expect(cap).toContain('$10 million');
    expect(cap).toContain('$15 million');
    // Every one of them is dated, so a reader can tell which stock it governs.
    for (const html of [assets, holding, cap]) expect(html).toContain('4 July 2025');
  });

  it('registers every specialty skeleton in the registry under its version', () => {
    for (const version of [
      'qsbs.v4',
      'ppa.v3',
      'impairment.v3',
      'esop.v3',
      'smb.v3',
      'emi.v3',
      'csop.v3',
      'ip.v3',
      '718.v3',
      '820.v3',
      'gifts.v3',
      'ifrs2.v3',
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
    // §409A-specific certification and its own index chapter.
    const a409 = templateForKind('409a');
    expect(a409.sections.find((s) => s.key === 'certification')!.html).toContain(
      'No one provided significant professional assistance',
    );
    // The index used to enumerate Exhibits A–H here, in the skeleton, which is
    // the one place that cannot know which of them the calculation produced.
    // What the authored chapter keeps is the marker; the list itself is built
    // at render from the schedules that follow — see the round trip in
    // reportExhibitIndex.test.ts and domain/reportExhibitIndex.ts.
    expect(a409.sections.find((s) => s.key === 'exhibit_index')!.html).toContain(EXHIBIT_INDEX_MARKER);
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
    // Every *instantiation-time* variable is gone. `{{signatures}}` is the one
    // marker that must survive: it resolves at render against the rows on file,
    // and a certification instantiated without it is one no signature can reach.
    // See domain/reportSignatures.ts.
    expect(cert?.html.replace('{{signatures}}', '')).not.toContain('{{');
    expect(cert?.html).toContain('{{signatures}}');
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

  it('escapes markup a company name smuggles into the body rather than deleting it', () => {
    const content = instantiate409a(XSS_NAME);
    // The name appears in several sections; none may carry a live tag.
    expect(content.sections.filter((s) => /<img/i.test(s.html))).toEqual([]);
    // Escaped, not stripped, which is the difference this asserts. Sanitizing
    // the substituted value made the payload inert by *deleting* it — and it
    // deletes an ordinary name's own angle brackets just as thoroughly, so
    // `A & B <Holdings> Ltd` was drafted as `A & B  Ltd` in the one document
    // whose first job is to say which company it values. See
    // `escapeTemplateVars`.
    const carrying = content.sections.filter((s) =>
      s.html.includes('&lt;img src=x onerror="alert(1)"&gt;Acme'),
    );
    expect(carrying.length).toBeGreaterThan(0);
  });

  it('keeps a company name whose own spelling looks like markup', () => {
    for (const name of ['A & B <Holdings> Ltd', 'Q < R Capital', "O'Brien & Sons"]) {
      const bodies = instantiate409a(name).sections.map((s) => s.html);
      // Decoding what the PDF renderer's `decodeEntities` decodes is what says
      // the reader gets the name back, character for character.
      const decoded = bodies.map((h) =>
        h
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&'),
      );
      expect(
        decoded.some((h) => h.includes(name)),
        name,
      ).toBe(true);
    }
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
 * "A clean 4x per doubling" is the whole diagnosis, so it is what these tests
 * assert: `expectSubQuadratic` grows the input fourfold and requires the cost
 * to grow by less than eight, halfway between the four a linear scan pays and
 * the sixteen the old regexes did. A ratio has no units and no opinion about
 * how fast the machine is, which is what the wall-clock budgets that used to
 * live here could not manage.
 */
describe('sanitizeHtml on input with no closing bracket', () => {
  it('sanitizes a section-sized run of unterminated tags in linear time', () => {
    expectSubQuadratic({ input: (n) => '<p'.repeat(n / 2), run: sanitizeHtml, size: 25_000 });
  });

  it('sanitizes a section-sized run of junk leads in linear time', () => {
    // `"<3"` exercises the second regex, the junk-tag sweep, which was
    // quadratic in exactly the same way and by exactly the same amount.
    expectSubQuadratic({ input: (n) => '<3'.repeat(n / 2), run: sanitizeHtml, size: 25_000 });
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

/**
 * The certification, against the rule that governs it.
 *
 * USPAP Standards Rule 10-3 lists nine statements a signed business-appraisal
 * certification must contain. Five were here and four were not, and the four
 * were not decorative: without the conformity statement the document does not
 * say what standard it was prepared under, and without the prior-services
 * disclosure the reader is left to infer from silence that there were none.
 *
 * Checked as substance rather than as a byte-for-byte fixture — an analyst may
 * reword the skeleton, and this is about what the certification has to *say*.
 * Checked across all fifteen kinds because the three separate copies that used
 * to exist are exactly how a gift-and-estate report came to certify less than a
 * 409A did.
 */
describe('the appraiser certification', () => {
  const REQUIRED: { of: string; match: RegExp }[] = [
    { of: 'SR 10-3(i) — statements of fact true and correct', match: /true and correct/i },
    { of: 'SR 10-3(ii) — personal, impartial, unbiased analyses', match: /impartial and unbiased/i },
    { of: 'SR 10-3(iii) — no present or prospective interest', match: /no present or prospective interest/i },
    {
      of: 'SR 10-3(iv) — prior services in the last three years',
      match: /three-year period immediately preceding/i,
    },
    { of: 'SR 10-3(v) — no bias', match: /no bias with respect to/i },
    {
      of: 'SR 10-3(vi) — engagement not contingent on a result',
      match: /engagement in this assignment was not contingent/i,
    },
    { of: 'SR 10-3(vii) — compensation not contingent', match: /compensation is not contingent/i },
    {
      of: 'SR 10-3(viii) — conformity with USPAP',
      match: /Uniform Standards of Professional Appraisal Practice/i,
    },
    {
      of: 'SSVS-1 — the other standard the work is done under',
      match: /Statement on Standards for Valuation Services No\. 1/i,
    },
    {
      of: 'SR 10-3(ix) — significant professional assistance',
      match: /significant professional assistance/i,
    },
  ];

  const certOf = (kind: (typeof VALUATION_KINDS)[number]) =>
    templateForKind(kind).sections.find((s) => s.key === 'certification');

  it('makes every one of the nine statements, on every report type', () => {
    for (const kind of VALUATION_KINDS) {
      const cert = certOf(kind);
      expect(cert, kind).toBeDefined();
      for (const required of REQUIRED) {
        expect(cert!.html, `${kind}: missing ${required.of}`).toMatch(required.match);
      }
    }
  });

  it('is one text, not fifteen', () => {
    // The property that makes the check above cheap to keep true. Three copies
    // drifted; one cannot.
    const texts = new Set(VALUATION_KINDS.map((k) => certOf(k)!.html));
    expect(texts.size).toBe(1);
  });

  it('sits before the qualifications and the index of exhibits', () => {
    /*
     * `withClosingSections` appends, so a skeleton that stopped declaring the
     * certification itself would gain it *after* the Index of Exhibits — a
     * signature page at the back of the schedules. The 409A and GIFTS name it
     * at the position they want for exactly this reason.
     */
    const keys = templateForKind('409a').sections.map((s) => s.key);
    expect(keys.indexOf('certification')).toBeGreaterThan(keys.indexOf('safe_harbor'));
    expect(keys.indexOf('certification')).toBeLessThan(keys.indexOf('qualifications'));
    expect(keys.indexOf('certification')).toBeLessThan(keys.indexOf('exhibit_index'));

    const gifts = templateForKind('gifts').sections.map((s) => s.key);
    expect(gifts.indexOf('certification')).toBeGreaterThan(gifts.indexOf('adequate_disclosure'));
    expect(gifts.indexOf('certification')).toBeLessThan(gifts.indexOf('exhibit_index'));
  });

  it('names the standards at the front of the 409A as well as the back', () => {
    // A reader checking what standard a valuation was prepared under looks at
    // the scope section, not at the certification eleven chapters later.
    const scope = templateForKind('409a').sections.find((s) => s.key === 'purpose_and_scope')!;
    expect(scope.html).toMatch(/Uniform Standards of Professional Appraisal Practice/);
    expect(scope.html).toMatch(/Statement on Standards for Valuation Services No\. 1/);
    expect(scope.html).toMatch(/detailed report/);
  });
});
