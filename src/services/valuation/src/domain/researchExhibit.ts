import type { ReportPdfSection } from '@n409/report/pdf';
import { esc, P, section, table } from './exhibitHtml.js';
import { RESEARCH_TOPIC_DEFS, isResearchTopic, REGION_LABELS, isResearchRegion } from './research.js';
import type { MarketResearchRow } from '../repos/marketResearch.js';

/**
 * The sources schedule: every public source the market discussion was drafted
 * from, with the question that retrieved it and when.
 *
 * This is the exhibit that makes web-grounded research worth having. A drafted
 * industry paragraph is only better than the model's own recollection if a
 * reviewer can follow it back to a publisher and a date — otherwise it is the
 * same guess in a more confident voice. So the exhibit lists the URL, not a
 * count of them, and it prints the retrieval date next to each answer because
 * a market multiple with no as-of date is not evidence of anything.
 *
 * Ungrounded rows are omitted entirely rather than listed with an empty source
 * column. An answer Sonar returned without citations did not travel into the
 * narrative either (`narrativeResearchPayload` filters it out), so printing it
 * here would advertise a source the report did not use.
 */

function topicLabel(topic: string, region: string | null): string {
  const base = isResearchTopic(topic) ? RESEARCH_TOPIC_DEFS[topic].label : topic;
  if (!region) return base;
  const market = isResearchRegion(region) ? REGION_LABELS[region] : region;
  return `${base} — ${market}`;
}

function day(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function researchSourcesExhibit(
  rows: readonly MarketResearchRow[],
): ReportPdfSection | null {
  const grounded = rows.filter((r) => Array.isArray(r.citations) && r.citations.length > 0);
  if (grounded.length === 0) return null;

  const sourceRows: string[][] = [];
  for (const row of grounded) {
    const label = esc(topicLabel(row.topic, row.region));
    const retrieved = day(row.created_at);
    for (const cite of row.citations) {
      const url = typeof cite?.url === 'string' ? cite.url : '';
      if (!url) continue;
      const title = typeof cite?.title === 'string' && cite.title.trim() !== '' ? cite.title : url;
      sourceRows.push([label, esc(title), esc(url), retrieved]);
    }
  }
  if (sourceRows.length === 0) return null;

  return section('Exhibit — Public Sources Consulted', [
    P(
      'The market and industry discussion in this report draws on the public sources below, ' +
        'retrieved on the dates shown. Each was read at the time of retrieval; figures are ' +
        'stated as of that date.',
    ),
    table({
      head: ['Topic', 'Source', 'URL', 'Retrieved'],
      rows: sourceRows,
    }),
  ]);
}
