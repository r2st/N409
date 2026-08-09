/**
 * The sources schedule — the exhibit that makes web-grounded research worth
 * having, and the last gate between a retrieved URL and a published 409A.
 *
 * The exhibit makes two claims in its own standing text: that the market
 * discussion "draws on" the sources listed, and that each "was read at the time
 * of retrieval". Every test here is really about one of those two sentences
 * staying true, because a source list that overstates either is worse than no
 * exhibit at all — it invites a reviewer to check a citation the report was
 * never written from.
 */

import { describe, expect, it } from 'vitest';
import { researchSourcesExhibit } from '../../src/domain/researchExhibit.js';
import type { MarketResearchRow } from '../../src/repos/marketResearch.js';

const row = (over: Partial<MarketResearchRow> = {}): MarketResearchRow =>
  ({
    id: '01J0000000000000000000000A',
    valuation_id: '01J0000000000000000000000V',
    topic: 'industry_overview',
    region: null,
    question: 'What are the prevailing revenue multiples for vertical SaaS?',
    answer: 'Vertical SaaS traded at 6-8x forward ARR through 2025.',
    citations: [{ url: 'https://example.com/saas-report', title: 'SaaS Multiples 2025' }],
    synthesized: true,
    model: 'duckduckgo+openai/gpt-oss-20b:free',
    requested_by: null,
    created_at: new Date('2026-07-01T12:00:00Z'),
    superseded_at: null,
    ...over,
  }) as MarketResearchRow;

describe('research sources exhibit', () => {
  it('lists a grounded row with its URL and retrieval date', () => {
    const out = researchSourcesExhibit([row()]);
    expect(out).not.toBeNull();
    expect(out!.heading).toBe('Exhibit — Public Sources Consulted');
    expect(out!.html).toContain('https://example.com/saas-report');
    expect(out!.html).toContain('SaaS Multiples 2025');
    // The as-of date is the point: a market multiple with no retrieval date is
    // not evidence of anything.
    expect(out!.html).toContain('2026-07-01');
  });

  it('omits the exhibit entirely when nothing is grounded', () => {
    // Null, not an empty table. A heading over no rows still tells a reader
    // that public sources were consulted.
    expect(researchSourcesExhibit([])).toBeNull();
    expect(researchSourcesExhibit([row({ citations: [] })])).toBeNull();
  });

  it('omits sources that were retrieved but never summarised', () => {
    // The case migration 0125 exists for. These URLs are real, so nothing about
    // the row looks malformed — but no answer was written from them, and the
    // exhibit's own text would claim each "was read at the time of retrieval".
    const out = researchSourcesExhibit([
      row({
        answer: 'Sources were retrieved for this question but could not be summarised.',
        synthesized: false,
        citations: [{ url: 'https://example.com/never-read', title: 'Unread' }],
      }),
    ]);
    expect(out).toBeNull();
  });

  it('keeps the summarised rows when another topic failed synthesis', () => {
    const out = researchSourcesExhibit([
      row({
        topic: 'industry_outlook',
        synthesized: false,
        citations: [{ url: 'https://example.com/never-read', title: 'Unread' }],
      }),
      row(),
    ]);
    expect(out).not.toBeNull();
    expect(out!.html).toContain('https://example.com/saas-report');
    expect(out!.html).not.toContain('https://example.com/never-read');
  });

  it('treats a row predating the synthesized column as summarised', () => {
    // Rows written before 0125 came from a path that could not produce an
    // unsynthesised result. Reading the absent field as false would strip the
    // sources exhibit out of every report drafted from older research.
    const legacy = row();
    delete (legacy as { synthesized?: boolean }).synthesized;
    expect(researchSourcesExhibit([legacy])).not.toBeNull();
  });

  it('skips a citation with no URL rather than printing a blank row', () => {
    const out = researchSourcesExhibit([
      row({
        citations: [{ url: '' }, { url: 'https://example.com/real' }] as MarketResearchRow['citations'],
      }),
    ]);
    expect(out!.html).toContain('https://example.com/real');
    expect(out!.html.match(/<tr>/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('returns null when the only row has citations that are all URL-less', () => {
    const out = researchSourcesExhibit([row({ citations: [{ url: '' }] as MarketResearchRow['citations'] })]);
    expect(out).toBeNull();
  });

  it('escapes a title so a source cannot inject markup into the exhibit', () => {
    // Titles come off third-party web pages, and this string is interpolated
    // into the report's HTML.
    const out = researchSourcesExhibit([
      row({
        citations: [
          { url: 'https://example.com/x', title: '<script>alert(1)</script>' },
        ] as MarketResearchRow['citations'],
      }),
    ]);
    expect(out!.html).not.toContain('<script>');
    expect(out!.html).toContain('&lt;script&gt;');
  });
});
