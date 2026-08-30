import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KIND_LABELS,
  SOURCE_LABELS,
  STATE_LABELS,
  kindLabel,
  sourceLabel,
  stateLabel,
} from '../src/lib/format';

/**
 * The browser's half of round 255 (round 262).
 *
 * R255 fixed eight server refusals that answered an operator with the value in
 * the `state` column, on the argument that the screen they are refused on has
 * labelled that same column "Changes requested" for as long as the browser has
 * had `STATE_LABELS`. That argument cuts both ways, and nobody had checked the
 * browser: a client on the progress page was told "This valuation is not
 * progressing (state: timeout)"; an outside auditor's header read
 * "1042 · 409A · draft_accepted"; the specialty tab said "A 409a engagement
 * runs through the standard calculation pipeline" from a picker that calls it
 * "IRC §409A"; and the detail page's Source row printed `ads` beside a filter
 * dropdown that says "Ads".
 *
 * Keyed on the interpolation, not on the four strings that happened to be
 * wrong, because the failure mode is the fifth. Scoped to the three columns
 * `format.ts` actually has a map for — `status`, `severity` and the rest are a
 * different question, and several of those are drawn as badges where the token
 * is the convention rather than a sentence.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(full) ? [full] : [];
  });
}

/**
 * Renders of one of these three columns that are not a label, and are not text
 * a reader sees. Each is here with the reason it is not the bug above.
 */
const ALLOWED = new Map<string, string>([
  // A React key, built from the row's discriminant. Never rendered.
  ['src/components/CommandPalette.tsx', '${row.kind}:${row.hit.id}'],
  // A path segment in a request URL.
  // Not `valuations.source`: where a comparable's market data came from,
  // which is a provider name rather than a member of an enum with a map.
  ['src/pages/valuation/Asc718Tab.tsx', '{result.market.source}'],
  // Not `valuations.source` either: `admin_events.source`, the subsystem that
  // wrote the row. Ops-facing, and deliberately the identifier a log is
  // grepped by — see the audit-trail memo.
  ['src/pages/valuation/AuditTrailTab.tsx', '${entry.source}'],
  // Not `valuations.source` either: which side of the delivery reported the
  // event — a provider webhook or an open pixel. Ops-facing, and the point of
  // the line is which of the two it was.
  ['src/pages/EmailOutboxPage.tsx', '{ev.source}|{ev.kind}'],
  // React keys and SVG attribute values. The visible cell beside them already
  // goes through `SOURCE_LABELS`, and a cap-table edge's kind is a line style,
  // not a valuation kind.
  ['src/pages/AdminJobsPage.tsx', '{job.source}|${job.source}|/admin/jobs/alert-rules/${rule.source}'],
  ['src/components/CapTableGraph.tsx', '{edge.kind}|${edge.kind}'],
]);

describe('the three columns the browser has a name for', () => {
  it('has a label for every member of each', () => {
    for (const [key, label] of Object.entries(STATE_LABELS)) expect(label, key).not.toBe(key);
    for (const [key, label] of Object.entries(KIND_LABELS)) expect(label, key).not.toBe(key);
    for (const [key, label] of Object.entries(SOURCE_LABELS)) expect(label, key).not.toBe(key);
  });

  it('echoes a value it has no name for rather than rendering nothing', () => {
    // The fallback matters: these arrive typed as `string`, and a kind added to
    // the API before this build knows it must still say something.
    expect(stateLabel('a_state_from_the_future')).toBe('a_state_from_the_future');
    expect(kindLabel('a_kind_from_the_future')).toBe('a_kind_from_the_future');
    expect(sourceLabel('a_source_from_the_future')).toBe('a_source_from_the_future');
    expect(stateLabel('draft_changes')).toBe('Changes requested');
    expect(kindLabel('409a')).toBe('IRC §409A');
    expect(sourceLabel('ads')).toBe('Ads');
  });

  it('draws no bare state, kind or source anywhere a reader can see it', () => {
    const files = sourceFiles(SRC);
    // A census that silently matches nothing passes.
    expect(files.length).toBeGreaterThan(80);

    const findings: string[] = [];
    for (const file of files) {
      const rel = path.relative(path.resolve(HERE, '..'), file).split(path.sep).join('/');
      const stripped = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      for (const m of stripped.matchAll(
        /\{[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*\.(?:state|kind|source)\}/g,
      )) {
        const hit = m[0];
        // Attribute values (`prop={x.kind}`) and null-coalesced reads are not
        // the shape this is about.
        const before = stripped.slice(Math.max(0, m.index! - 1), m.index!);
        if (before === '=') continue;
        if (ALLOWED.get(rel)?.includes(hit)) continue;
        findings.push(`${rel} → ${hit}`);
      }
      for (const m of stripped.matchAll(
        /\$\{[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*\.(?:state|kind|source)\}/g,
      )) {
        if (ALLOWED.get(rel)?.includes(m[0])) continue;
        findings.push(`${rel} → ${m[0]}`);
      }
    }
    expect(findings, 'a lifecycle state, engagement kind or lead source drawn as its column value').toEqual(
      [],
    );
  });
});
