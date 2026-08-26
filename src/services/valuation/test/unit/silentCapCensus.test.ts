import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A cap that never says it is a cap.
 *
 * `truncationNoticeCensus` in the frontend asks "does every truncating endpoint
 * render a notice", and it is blind by construction to the failure that matters
 * more: a query with a hard-coded `LIMIT 20` and no flag beside it is not a
 * truncating endpoint as far as that census can tell. It has no `truncated` in
 * the route, no `truncated: boolean` in the repo signature, and nothing to map.
 * It passes by having nothing to be asked about.
 *
 * Ten queries were in exactly that state — the invitation ledger, the support
 * and contact inboxes, the payment ledger and the pay-now list, the engine-run,
 * agent-run, QA and data-health histories, and an instrument's measurement
 * trail. Each read like a complete list to the screen drawing it, and four of
 * them were summed or counted rather than merely listed: the billing page's
 * "total paid" is `collectedTotals(payments)` over a 500-row page, and the
 * auditor portal's `qa_count` is `qa.length` over a 20-row one. A short page
 * there is not a short list, it is a wrong number stated with confidence.
 *
 * So the rule is stated in the direction that catches the next one: a numeric
 * `LIMIT` written into repo SQL has to come with a way for the caller to learn
 * the cap bit, or be named here with the reason it cannot mislead. `LIMIT 1`
 * and `LIMIT $n` are excluded — the first is a lookup, the second is a caller's
 * own page size and is where the flag lives.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPOS = path.resolve(here, '../../src/repos');

/**
 * Queries whose literal cap cannot mislead a reader, and why.
 *
 * An exemption states what makes the cap unreachable or the flag meaningless —
 * never merely that nobody got to it.
 */
const EXEMPT: Record<string, string> = {
  // Empty, and that is the point: every capped query in the repos now reports
  // its cap. `listCalculationTraces` was the one candidate for an exemption —
  // it deliberately shares `listCalculations`'s twenty-run window so the traces
  // in an evidence bundle describe the runs in the same bundle — and it takes
  // that window as a parameter from `CALCULATION_PAGE_LIMIT` rather than
  // re-typing the number, so it is not a literal cap and does not need one.
};

/** `LIMIT 20`, but not `LIMIT 1` and not `LIMIT $2`. */
const LITERAL_LIMIT = /\bLIMIT\s+(\d+)\b/gi;

interface Fn {
  name: string;
  body: string;
}

/** Exported functions of a repo module, sliced at the next top-level `export`. */
function exportedFunctions(src: string): Fn[] {
  const out: Fn[] = [];
  const starts = [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]!.index! : src.length;
    out.push({ name: m[1]!, body: src.slice(m.index!, end) });
  }
  return out;
}

/** Code only: these files discuss `LIMIT` in prose constantly. */
function code(body: string): string {
  return body
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
}

function silentCaps(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(REPOS).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(path.join(REPOS, file), 'utf8');
    for (const fn of exportedFunctions(src)) {
      const body = code(fn.body);
      const caps = [...body.matchAll(LITERAL_LIMIT)].map((m) => Number(m[1]));
      // A single-row lookup is not a page.
      if (!caps.some((n) => n > 1)) continue;
      if (/truncated/.test(body)) continue;
      found.push(`${file}:${fn.name}`);
    }
  }
  return found.sort();
}

describe('a capped list carries a flag', () => {
  const caps = silentCaps();

  it('is reading the repo sources at all', () => {
    // The vacuity guard. This census passes trivially the moment the export
    // regex stops matching or `LITERAL_LIMIT` stops firing, and a guard that
    // has quietly stopped asking is worse than no guard.
    const all = readdirSync(REPOS).filter((f) => f.endsWith('.ts'));
    expect(all.length).toBeGreaterThan(20);
    const anyLimit = all.some((f) =>
      /\bLIMIT\s+\d+\b/i.test(code(readFileSync(path.join(REPOS, f), 'utf8'))),
    );
    expect(anyLimit).toBe(true);
    // Exported functions are found at all — the regex above is the census's
    // only way of attributing a `LIMIT` to something nameable.
    const names = exportedFunctions(readFileSync(path.join(REPOS, 'funds.ts'), 'utf8')).map((f) => f.name);
    expect(names).toContain('listPositions');
  });

  it('has no repo query capped in silence', () => {
    expect(caps.filter((c) => !(c in EXEMPT))).toEqual([]);
  });

  it('exempts nothing that has stopped being capped', () => {
    expect(Object.keys(EXEMPT).filter((e) => !caps.includes(e))).toEqual([]);
  });

  it('states a reason for every exemption', () => {
    expect(
      Object.entries(EXEMPT)
        .filter(([, why]) => !why.trim())
        .map(([k]) => k),
    ).toEqual([]);
  });

  /**
   * The detector's own guard: a census that cannot see the bug it exists for is
   * the shape of the bug. `LIMIT 1` must stay invisible and `LIMIT 50` must not.
   */
  it('would catch a page capped without a flag, and ignore a single-row lookup', () => {
    const capped = `export async function listThings(pool: pg.Pool) {
      const { rows } = await pool.query('SELECT * FROM things LIMIT 50');
      return rows;
    }`;
    const lookup = `export async function findThing(pool: pg.Pool) {
      const { rows } = await pool.query('SELECT * FROM things ORDER BY created_at DESC LIMIT 1');
      return rows[0] ?? null;
    }`;
    const flagged = `export async function listThings(pool: pg.Pool) {
      const { rows } = await pool.query('SELECT * FROM things LIMIT 51');
      return { things: rows.slice(0, 50), truncated: rows.length > 50 };
    }`;
    const caught = (src: string) =>
      exportedFunctions(src).some((fn) => {
        const body = code(fn.body);
        return [...body.matchAll(LITERAL_LIMIT)].some((m) => Number(m[1]) > 1) && !/truncated/.test(body);
      });
    expect(caught(capped)).toBe(true);
    expect(caught(lookup)).toBe(false);
    expect(caught(flagged)).toBe(false);
  });
});
