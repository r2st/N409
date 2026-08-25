import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DataTable } from '../src/components/ui';
import { Heatmap } from '../src/components/charts';
import { SearchPage } from '../src/pages/SearchPage';
import type { User } from '../src/lib/types';

/**
 * A census of the platform's tables, and two proofs that the census asks for
 * the right thing.
 *
 * `DataTable` is the accessible table primitive, and four screens use it. The
 * other 80-odd tables are hand-rolled, and before R122 half of them had no
 * accessible name and fourteen had no `<th>` at all. Both are invisible to a
 * sighted reviewer and to every existing test: a table with no name renders
 * identically to one with an `sr-only` caption, and a table with no column
 * headers renders identically to one with an `sr-only` header row.
 *
 * So the guard is a source scan. Two rules, no allowlist:
 *
 *   1. every table exposed to the accessibility tree carries a name — a
 *      `<caption>`, an `aria-label`, or an `aria-labelledby`;
 *   2. every one of them has at least one `<th>`, so its cells are associated
 *      with something.
 *
 * A table that is genuinely decoration opts out the way `SkeletonTable` does,
 * by saying `role="presentation"` or `aria-hidden` on the tag itself — which
 * is a claim a reviewer can see and argue with, unlike silence.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

type Found = { file: string; line: number; named: boolean; hasHeader: boolean; labelledBy: string | null };

/**
 * Every `<table>` this app renders.
 *
 * Comments are blanked (newlines kept, so line numbers survive) because the
 * codebase writes `<table>` in prose when explaining itself, and a `<table>`
 * immediately preceded by a quote is a string constant — the rich-text
 * editor's blank-table snippet is document content, not this app's UI.
 */
function tables(): Found[] {
  const found: Found[] = [];
  for (const full of walk(SRC)) {
    const src = readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of src.matchAll(/<table\b([^>]*)>/g)) {
      const attrs = m[1] ?? '';
      const at = m.index ?? 0;
      if (/['"`]/.test(src[at - 1] ?? '')) continue;
      if (/aria-hidden|role="presentation"/.test(attrs)) continue;
      const after = src.slice(at + m[0].length);
      const close = after.indexOf('</table>');
      const body = close === -1 ? after : after.slice(0, close);
      // A caption is only the table's name while it precedes the first row
      // group; anywhere else it is invalid and the browser moves it.
      const firstGroup = body.search(/<(thead|tbody|tfoot|colgroup|tr)\b/);
      const head = firstGroup === -1 ? body : body.slice(0, firstGroup);
      found.push({
        file: path.relative(SRC, full),
        line: src.slice(0, at).split('\n').length,
        named: /aria-label(ledby)?\s*=/.test(attrs) || /<caption\b/.test(head),
        hasHeader: /<th\b/.test(body),
        labelledBy: /aria-labelledby="([^"]+)"/.exec(attrs)?.[1] ?? null,
      });
    }
  }
  return found;
}

const TABLES = tables();

describe('every data table names itself', () => {
  it('finds the tables at all', () => {
    // Without this the two assertions below pass by scanning nothing — the
    // failure mode of every source scan in this suite.
    expect(TABLES.length).toBeGreaterThan(70);
  });

  it('carries an accessible name on every table', () => {
    const anonymous = TABLES.filter((t) => !t.named).map((t) => `${t.file}:${t.line}`);
    expect(anonymous).toEqual([]);
  });

  it('carries at least one header cell on every table', () => {
    const headerless = TABLES.filter((t) => !t.hasHeader).map((t) => `${t.file}:${t.line}`);
    expect(headerless).toEqual([]);
  });

  it('points every static aria-labelledby at an id in the same file', () => {
    // A name by reference is silently nothing when the reference is stale —
    // worse than no name, because the scan above counts it as named.
    const dangling: string[] = [];
    let checked = 0;
    for (const t of TABLES) {
      if (!t.labelledBy) continue;
      checked++;
      const text = readFileSync(path.join(SRC, t.file), 'utf8');
      if (!text.includes(`id="${t.labelledBy}"`)) dangling.push(`${t.file}:${t.line} → ${t.labelledBy}`);
    }
    expect(checked).toBeGreaterThan(0);
    expect(dangling).toEqual([]);
  });
});

/*
 * The scan reads source. These read the accessibility tree, so that the thing
 * the scan asks for is known to be the thing that reaches a screen reader —
 * once per naming mechanism the platform uses.
 */
describe('the naming mechanisms reach the accessibility tree', () => {
  it('names a DataTable from its caption', () => {
    render(
      <MemoryRouter>
        <DataTable
          caption="Portfolio companies"
          columns={[{ key: 'name', header: 'Company' }]}
          rows={[{ name: 'Acme Robotics' }]}
          rowKey={(r) => r.name}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('table', { name: 'Portfolio companies' })).toBeInTheDocument();
  });

  it('names a Heatmap from the heading it points at', () => {
    render(
      <Heatmap
        title="Volatility × Discount rate"
        rowLabel="Volatility"
        colLabel="Discount rate"
        rowValues={['40%']}
        colValues={['12%']}
        cells={[[{ value: 3.2, delta: 0 }]]}
        format={(v) => `$${v.toFixed(2)}`}
      />,
    );
    expect(screen.getByRole('table', { name: 'Volatility × Discount rate' })).toBeInTheDocument();
  });
});

const mockUser = {
  id: '01N409USER00000000000000OP',
  email: 'ops@example.com',
  roles: ['admin'],
} as unknown as User;

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: mockUser }) }));

describe('a screen-reader-only header row still gives the columns names', () => {
  afterEach(() => vi.restoreAllMocks());

  it('distinguishes the three search result tables and names their columns', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          valuations: [
            {
              id: '01N409VAL00000000000000AA',
              company_name: 'Acme Robotics',
              number: '42',
              kind: '409a',
              state: 'published',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ],
          documents: [],
          users: [
            {
              id: '01N409USER00000000000000AA',
              first_name: 'Dana',
              last_name: 'Reed',
              email: 'dana@example.com',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    render(
      <MemoryRouter initialEntries={['/search?q=acme']}>
        <SearchPage />
      </MemoryRouter>,
    );

    // Three result tables on one page: before R122 all three announced as
    // "table" and nothing told them apart.
    const valuations = await waitFor(() => screen.getByRole('table', { name: 'Matching valuations' }));
    expect(screen.getByRole('table', { name: 'Matching users' })).toBeInTheDocument();

    // The header row is `sr-only`, so it is in the tree without being on the
    // page: the columns have names, and the row's cells are associated to them.
    expect(within(valuations).getByRole('columnheader', { name: 'Valuation' })).toBeInTheDocument();
    expect(within(valuations).getByRole('columnheader', { name: 'Created' })).toBeInTheDocument();
    expect(within(valuations).getAllByRole('columnheader')).toHaveLength(4);
  });
});
