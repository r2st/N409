import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A list that stopped short and did not say so.
 *
 * Every list endpoint in this API is capped in SQL, and each one reports
 * `truncated` beside the rows for one stated reason: a page must not be
 * mistaken for the whole set. `repos/retention.ts` says it outright — "a
 * truncated list looks exactly like a complete one" — and `listAllInvoices`
 * was rewritten in the list-query pass specifically to say *when* the cap bit.
 *
 * Twelve client surfaces took the rows and dropped the flag. The failure that
 * causes is silent by construction: a missing engagement reads as an
 * engagement that does not exist, an unlisted legal hold reads as data free to
 * delete, and any figure a page derives from `rows.length` — the engagement
 * pipeline's "N active", its per-stage counts — becomes a wrong number stated
 * with confidence rather than a short list. The ops billing dashboard managed
 * both halves at once: it typed `invoices`, `invoices_truncated`,
 * `subscriptions_truncated`, `page_limit` and `invoice_page_limit`, and
 * rendered none of them.
 *
 * So the rule is stated once, here, and in the direction that catches the
 * *next* one: the census reads the valuation service's own route sources for
 * responses carrying a truncation flag, and every endpoint it finds has to be
 * in {@link CONSUMERS} — mapped either to the client files that render a
 * notice, or to an exemption with its reason. A new capped endpoint fails this
 * file on the day it is added, before anyone has to notice a list is short.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src');
const ROUTES = path.resolve(here, '../../valuation/src/routes');
const REPOS = path.resolve(here, '../../valuation/src/repos');

/**
 * Endpoint → the client files answerable for its truncation flag.
 *
 * `renders` names files that must show a notice; `why` exempts the endpoint
 * with a reason. A census whose exceptions are implicit is one nobody can
 * audit, so every exemption states what makes the cap unreachable or the
 * notice wrong — not merely that nobody got to it.
 */
const CONSUMERS: Record<string, { renders?: string[]; why?: string }> = {
  '/api/v1/admin/billing': { renders: ['src/components/SubscriptionSection.tsx'] },
  '/api/v1/engagements': { renders: ['src/pages/EngagementsPage.tsx'] },
  '/api/v1/saved-views': { renders: ['src/components/SavedViews.tsx'] },
  '/api/v1/report-templates': { renders: ['src/pages/TemplatesPage.tsx'] },
  '/api/v1/admin/retention/holds': { renders: ['src/pages/AdminRetentionPage.tsx'] },
  '/api/v1/admin/sso/scim-tokens': { renders: ['src/pages/AdminSsoPage.tsx'] },
  '/api/v1/admin/prompts/:id/versions': { renders: ['src/pages/BotPromptsPage.tsx'] },
  '/api/v1/valuations/:id/comments': { renders: ['src/components/CommentThread.tsx'] },
  '/api/v1/valuations/:id/grants': { renders: ['src/pages/valuation/GrantsTab.tsx'] },
  '/api/v1/valuations/:id/events': { renders: ['src/pages/ValuationDetailPage.tsx'] },
  '/api/v1/valuations/:id/audit-trail': { renders: ['src/pages/valuation/AuditTrailTab.tsx'] },
  '/api/v1/valuations/:id/cap-table/upload': { renders: ['src/pages/valuation/CapTableTab.tsx'] },
  '/api/v1/valuations/export': { renders: ['src/pages/ValuationsPage.tsx'] },
  '/api/v1/funds': { renders: ['src/pages/FundPortfolioPage.tsx'] },
  '/api/v1/monitors': { renders: ['src/pages/MonitorsPage.tsx'] },
  '/api/v1/admin/api-tokens': { renders: ['src/pages/AdminApiTokensPage.tsx'] },
  '/api/v1/admin/documents/triage': { renders: ['src/pages/AdminDocumentsPage.tsx'] },
  '/api/v1/admin/data-remediation': { renders: ['src/pages/AdminDataRemediationPage.tsx'] },
  '/api/v1/firm/attention': { renders: ['src/pages/FirmDashboardPage.tsx'] },
  '/api/v1/firm/dashboard': { renders: ['src/pages/FirmDashboardPage.tsx'] },
  '/api/v1/organizations': {
    renders: ['src/pages/PortfolioPage.tsx', 'src/components/valuation/OrgAssignmentCard.tsx'],
  },
  '/api/v1/organizations/:id': { renders: ['src/pages/PortfolioPage.tsx'] },
  '/api/v1/organizations/:id/consolidated': { renders: ['src/pages/PortfolioPage.tsx'] },
  '/api/v1/partners': { renders: ['src/pages/AdminUsersPage.tsx', 'src/pages/ValuationsPage.tsx'] },
  '/api/v1/users/options': {
    renders: [
      'src/components/WorkflowActions.tsx',
      'src/pages/ValuationsPage.tsx',
      'src/pages/TasksPage.tsx',
      'src/pages/ActivityLogPage.tsx',
    ],
  },
  '/api/v1/help/articles': {
    renders: ['src/pages/AdminHelpPage.tsx'],
    why: 'The reader-facing HelpPage merges these with the static knowledge base, so `rows.length` there counts both and a note quoting it would state a number that is not the CMS page. The editorial list — the one where a missing article becomes a duplicate article — is AdminHelpPage, and it renders the notice.',
  },
  '/api/v1/valuations/:id/workbook': {
    why: 'The cap (WORKBOOK_CELL_LIMIT = 2000) is bounded well above every address the workbook model defines, and `computeWorkbook` reads only those addresses — so a well-formed workbook cannot reach it. `routes/reports.ts` relies on the same fact for the report appendix.',
  },
  '/api/v1/valuations/:id/workbook/tabs': {
    why: 'Same cells, same bound, and the same reasoning as `/workbook` above — the tabs are built by `buildWorkbookTabs` from addresses the model defines.',
  },
  '/api/v1/valuations/:id/workbook.xlsx': {
    why: 'Same cells and same bound as `/workbook`. The grant schedule inside this workbook is the one list here that could truncate, and `routes/exports.ts` refuses the whole export rather than shipping a short schedule — a refusal the caller cannot miss.',
  },
  '/api/v1/valuations/:id/evidence-bundle': {
    why: 'Not a screen. The bundle carries its caps as a `truncated` object inside the manifest written into the archive, which is the artefact an auditor reads; there is no rendered list to annotate.',
  },
};

/** Anything a client would read as "there is more than this". */
const TRUNCATION_KEY = /(^|[^a-z_])[a-z_]*truncated\s*[,:}]/;

/**
 * The primitives that say so, plus the two shapes a file renders the flag in
 * by hand — a guard (`truncated && …`) and a ternary (FirmDashboardPage turns
 * it into the word "at least" in front of a count).
 *
 * The ternary arm excludes a following colon on purpose: `truncated?: boolean`
 * is a *declaration* of the flag, and counting it would let a file pass this
 * census by typing the field and drawing nothing — which is precisely the
 * defect the census exists to catch.
 */
const RENDERS_NOTICE =
  /<ListTruncationNote\b|<PickerOverflowNote\b|<QueueTruncationNote\b|[Tt]runcated\s*&&|[Tt]runcated\s*\?(?!:)/;

function walk(dir: string, out: string[] = [], ext = '.tsx'): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out, ext);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

/**
 * Route sources, split into one segment per `app.<verb>('/path'`.
 *
 * Crude on purpose: a segment runs to the next handler registration, so a
 * truncation flag anywhere in a handler is attributed to it. Over-attribution
 * costs an entry in the map; under-attribution would cost a silent list.
 */
/**
 * Repo functions whose result carries a truncation flag.
 *
 * Needed because the flag is often invisible in the route: `/api/v1/partners`
 * is `return listPartners(...)`, and the whole `{ rows, truncated }` object
 * goes on the wire without the word appearing in the handler at all. A census
 * that only read the route text would have called those endpoints uncapped —
 * a false negative, which is the direction that costs a silent list.
 */
function truncatingRepoFns(): Set<string> {
  const names = new Set<string>();
  for (const file of walk(REPOS, [], '.ts')) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(
      /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*(\([\s\S]*?)(?=\n(?:export|\/\*\*|})|$)/g,
    )) {
      const name = m[1] ?? '';
      const signature = m[2] ?? '';
      const brace = signature.indexOf('{');
      const head = signature.slice(0, brace === -1 ? 400 : brace + 400);
      if (name && /truncated\s*:\s*boolean/.test(head)) names.add(name);
    }
  }
  return names;
}

function truncatingEndpoints(): string[] {
  const repoFns = truncatingRepoFns();
  const found = new Set<string>();
  for (const file of walk(ROUTES, [], '.ts')) {
    const src = readFileSync(file, 'utf8');
    const parts = src.split(/app\.(?:get|post|patch|put|delete)\(\s*'/);
    for (const part of parts.slice(1)) {
      const endpoint = part.slice(0, part.indexOf("'"));
      if (!endpoint.startsWith('/api/v1/')) continue;
      const body = part.slice(part.indexOf("'"));
      // Comment lines discuss truncation constantly; only code counts.
      const code = body
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
      const callsTruncating = [...repoFns].some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(code));
      if (TRUNCATION_KEY.test(code) || callsTruncating) found.add(endpoint);
    }
  }
  return [...found].sort();
}

describe('a capped list says it was capped', () => {
  const endpoints = truncatingEndpoints();

  it('is reading the route sources at all', () => {
    // The vacuity guard. This census passes trivially the moment the split
    // stops matching — a route registered through a helper, a verb this regex
    // does not know — and a guard that has quietly stopped asking is worse
    // than no guard, because the green tick is what stops anyone looking.
    expect(endpoints.length).toBeGreaterThan(15);
    expect(endpoints).toContain('/api/v1/admin/billing');
    expect(endpoints).toContain('/api/v1/engagements');
  });

  it('has every truncating endpoint accounted for', () => {
    const unmapped = endpoints.filter((e) => !(e in CONSUMERS));
    expect(unmapped).toEqual([]);
  });

  it('maps nothing that has stopped truncating', () => {
    const stale = Object.keys(CONSUMERS).filter((e) => !endpoints.includes(e));
    expect(stale).toEqual([]);
  });

  it('renders a notice in every file the map holds answerable', () => {
    const silent: string[] = [];
    for (const [endpoint, entry] of Object.entries(CONSUMERS)) {
      for (const file of entry.renders ?? []) {
        const src = readFileSync(path.resolve(SRC, '..', file), 'utf8');
        if (!RENDERS_NOTICE.test(src)) silent.push(`${endpoint} → ${file}`);
      }
    }
    expect(silent).toEqual([]);
  });

  it('states a reason for every endpoint that renders nothing', () => {
    const unexplained = Object.entries(CONSUMERS)
      .filter(([, e]) => (e.renders ?? []).length === 0 && !e.why?.trim())
      .map(([endpoint]) => endpoint);
    expect(unexplained).toEqual([]);
  });

  /**
   * The detector's own guard. `RENDERS_NOTICE` is a regex over source, so it
   * can rot into something that matches every file — and a census that always
   * says yes is the shape of the bug it exists to catch.
   */
  it('would fail a file that reads the flag and never draws it', () => {
    const typedButNotDrawn = `
      interface Page { rows: string[]; truncated: boolean }
      export function Page({ data }: { data: Page }) {
        return <ul>{data.rows.map((r) => <li key={r}>{r}</li>)}</ul>;
      }
    `;
    expect(RENDERS_NOTICE.test(typedButNotDrawn)).toBe(false);
    // An optional declaration is still a declaration — it must not satisfy the
    // ternary arm.
    expect(RENDERS_NOTICE.test('interface P { truncated?: boolean }')).toBe(false);
    expect(RENDERS_NOTICE.test(`${typedButNotDrawn}<ListTruncationNote truncated={x} />`)).toBe(true);
    expect(RENDERS_NOTICE.test("{data.truncated ? 'at least ' : ''}")).toBe(true);
  });
});
