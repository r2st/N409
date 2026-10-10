import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every `export async function list*` in repos/ must either include a LIMIT
 * in its query or be exempted below with a reason why unbounded is safe.
 *
 * M13 found two per-valuation list queries (`listScenarios`, `listSignatures`)
 * that relied solely on insert-side caps to bound the result set. Both now
 * carry a defensive LIMIT, and this census ensures no future list query ships
 * without one.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPOS = path.resolve(here, '../../src/repos');

/**
 * Functions whose queries are intentionally unbounded, with an explanation of
 * what bounds the result set instead. An exemption states why the query cannot
 * grow — never merely that nobody has got to it.
 */
const EXEMPT: Record<string, string> = {
  'communications.ts listCommunicationTemplates':
    'Admin-managed reference table; rows are hand-created templates, cardinality < 50',
  'communications.ts listAutoEmails':
    'Admin-managed reference table; rows are hand-created auto-email rules, cardinality < 20',
  'narrativePrompts.ts listNarrativePrompts':
    'Admin-managed reference table; rows are hand-created prompt templates, cardinality < 100',
  'narrativePrompts.ts listNarrativePromptsForKind':
    'Subset of narrative_prompts filtered by kind; parent table is admin-managed reference data',
  'ssoConfig.ts listSsoConfigs':
    'One SSO config per org; orgs are a small admin-managed set',
  'healthChecks.ts listHealthCheckItems':
    'Static health-check definitions seeded at deploy time',
  'accountingConnections.ts listConnections':
    'Per-valuation, bounded by the accounting-provider enum (< 5 providers)',
  'boardApprovals.ts listBoardMembers':
    'Per-resolution, bounded by board size (< 20 members)',
  'jobAlerts.ts listJobAlertRules':
    'Admin-managed configuration table; rows are hand-created alert rules, cardinality < 30',
  'mfa.ts listUnusedBackupCodeHashes':
    'Per-user backup codes generated in a fixed batch of 10',
};

function extractFunctionSpans(source: string): { name: string; span: string }[] {
  const results: { name: string; span: string }[] = [];
  const pattern = /export\s+async\s+function\s+(list\w+)/g;
  const matches = [...source.matchAll(pattern)];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index!;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : source.length;
    results.push({ name: matches[i]![1]!, span: source.slice(start, end) });
  }
  return results;
}

describe('repo list-function LIMIT census', () => {
  const files = readdirSync(REPOS).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  for (const file of files) {
    const source = readFileSync(path.join(REPOS, file), 'utf8');
    const fns = extractFunctionSpans(source);

    for (const fn of fns) {
      const key = `${file} ${fn.name}`;

      if (EXEMPT[key]) {
        it(`${key} — exempt: ${EXEMPT[key]}`, () => {
          expect(EXEMPT[key]).toBeTruthy();
        });
        continue;
      }

      it(`${key} includes a LIMIT`, () => {
        const hasLimit =
          /LIMIT\b/i.test(fn.span) ||
          /\blimit\b/i.test(fn.span) ||
          /PAGE_LIMIT/i.test(fn.span);
        expect(hasLimit, `${key} has no LIMIT — add one or exempt it with a reason`).toBe(true);
      });
    }
  }
});
