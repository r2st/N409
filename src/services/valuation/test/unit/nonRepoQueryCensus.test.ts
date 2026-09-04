import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The SQL that is not in `src/repos`, and which no census could see.
 *
 * Three censuses ask about the shape of a query and all three enumerate the
 * same directory. `unboundedListCensus` reads `src/repos` for a multi-row read
 * with no `LIMIT`; `silentCapCensus` reads `src/repos` for a literal `LIMIT`
 * with no flag; `truncationNoticeCensus` in the frontend reads route sources
 * for a flag that reached a screen, and it finds the flag by looking for repo
 * functions that carry one. A query written anywhere else is outside all three
 * populations at once, and the way that reads in a test run is three green
 * suites.
 *
 * It is not a small anywhere-else. Twenty-odd `SELECT`s live in `src/routes`,
 * `src/hooks`, `src/events` and `src/domain`, and two of the multi-row ones
 * were unbounded when this file was written:
 *
 *   * `GET /valuations/:id/progress` returned every client-visible event the
 *     valuation had ever recorded — a row per upload, per state transition and
 *     per render — because the read was `listEvents` in `events/record.ts`
 *     called from the route rather than a repo function with a page size; and
 *   * the evidence bundle's own two reads, `review_tasks` and `admin_events`,
 *     which grow with the review cycles and the administrative acts on an
 *     engagement, in a route whose other ten lists each carry a page limit and
 *     report it on the manifest.
 *
 * So the rule is stated where the gap is, and in the direction that catches
 * the next one: every `SELECT` outside `src/repos` either carries a `LIMIT` or
 * is named below with what bounds its row count. "Nobody has hit it" is not a
 * bound; the entry has to say what makes the number of rows finite — a primary
 * key, a unique constraint, an enum, a caller's own page, or a literal cap
 * somewhere else in the same statement.
 *
 * `src/db` is out of scope: its queries are the migration runner's, over
 * Postgres's own catalogs, and they answer questions about the cluster rather
 * than about this service's data.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../src');

/**
 * What bounds each uncapped `SELECT` written outside the repo layer.
 *
 * `bound` is the mechanism, in one of five kinds:
 *
 *   * `key`      — the predicate is a primary key or a unique column, so the
 *                  statement returns at most one row.
 *   * `caller`   — the predicate is `= ANY($ids)` over a list the caller has
 *                  already bounded.
 *   * `schema`   — an enum or a uniqueness constraint caps the row count at
 *                  something the schema itself states.
 *   * `curated`  — an administrator-managed table with no self-serve write
 *                  path.
 *   * `scalar`   — the statement returns one row by construction: a count, a
 *                  `now()`, a lock acquisition, a liveness `SELECT 1`.
 */
interface Bound {
  bound: 'key' | 'caller' | 'schema' | 'curated' | 'scalar';
  why: string;
}

const BOUNDED: Record<string, Bound> = {
  'app.ts:-': {
    bound: 'scalar',
    why: 'The readiness probe’s `SELECT 1`. One row by construction; it exists to prove the pool can reach the database at all.',
  },
  'index.ts:-': {
    bound: 'scalar',
    why: 'The same `SELECT 1`, on the boot path rather than the probe — the process refuses to start against a database it cannot query.',
  },
  'domain/integrationActor.ts:valuations': {
    bound: 'key',
    why: 'Whose engagement one valuation is, by primary key, so the OAuth callback can re-run the scope check `/connect` made — uncached, because the whole question is whether the answer is still current.',
  },
  'domain/retiredEngagement.ts:valuations': {
    bound: 'key',
    why: 'Whether one engagement is withdrawn, by primary key, taken `FOR SHARE` so a retirement landing mid-transaction cannot commit between the guard and the write it guards.',
  },
  'domain/retiredEngagement.ts:valuations#2': {
    bound: 'key',
    why: 'The same question on the pool rather than in a transaction, for the callers that only read: one engagement by primary key.',
  },
  'domain/transitionGuard.ts:valuations': {
    bound: 'key',
    why: 'The state of one valuation by primary key, taken `FOR UPDATE` so the transition it guards serialises against a second one.',
  },
  'events/record.ts:valuation_events': {
    bound: 'caller',
    why: '`listEvents` without a `limit`. The branch survives because the audit trail pages the spine itself, and every route caller now passes one — see the suite below, which holds that.',
  },
  'events/record.ts:unnest': {
    bound: 'caller',
    why: "Not a read at all: it is the row source of `recordEvents`' `INSERT … SELECT * FROM unnest(...)`, so it returns exactly the array length the caller built in this process and nothing is fetched back (R351 wrote it that way to stop one round trip per released engagement). Uncapped and unreachable by growth in the database — the only way to make it larger is to pass a longer array.",
  },
  'events/record.ts:valuation_events#2': {
    bound: 'schema',
    why: '`firstEntryPerState`: the `DISTINCT ON` over the target state returns one row per state the valuation has been in, and the states are the `ValuationState` enum.',
  },
  'hooks/autoEmails.ts:-': {
    bound: 'scalar',
    why: 'The sweep’s clock, `SELECT now()`, read from the database so every row it writes shares one instant. One row. The two advisory-lock statements that used to sit above it moved to `db/sweepLock.ts` (R292), which this census does not scan — see OUT_OF_SCOPE.',
  },
  'hooks/partnerWebhooks.ts:valuations': {
    bound: 'key',
    why: 'One valuation by primary key, read to build the webhook body for a state change on it.',
  },
  'hooks/partnerWebhooks.ts:valuations#2': {
    bound: 'caller',
    why: 'One row per id in `= ANY($1::ulid[])`, and the id list is the batch of deliveries the sweep has already leased.',
  },
  'hooks/stateChange.ts:partners': {
    bound: 'key',
    why: 'The sending partner’s name and template overrides, by primary key.',
  },
  'hooks/stateChange.ts:valuation_params': {
    bound: 'key',
    why: 'The valuation date for one valuation. `valuation_params` is unique on `valuation_id`, so this is a single row.',
  },
  'routes/account.ts:users': {
    bound: 'scalar',
    why: 'A `count(*)` of the administrators who would remain — the guard that refuses to remove the last one. One row.',
  },
  'routes/billing.ts:subscriptions': {
    bound: 'key',
    why: 'One subscription by `stripe_subscription_id`, which is unique (0104) because Stripe’s id is the identity of the row.',
  },
  'routes/branding.ts:partners': {
    bound: 'curated',
    why: 'Every live tenant, for the ops-only white-label roster. `partners` is created by an administrator through `POST /partners`; it grows by a deliberate act rather than by use, and the roster is meaningless as a page.',
  },
  'routes/communications.ts:partners': {
    bound: 'key',
    why: 'The sending partner’s name for a template preview, by primary key.',
  },
  'routes/communications.ts:valuation_params': {
    bound: 'key',
    why: 'The valuation date behind a template variable. Unique on `valuation_id`.',
  },
  'routes/emailDelivery.ts:email_outbox': {
    bound: 'key',
    why: 'The recipient of one outbox row by primary key, read to decide whether the address is suppressed.',
  },
  'routes/evidence.ts:ai_prompt_versions': {
    bound: 'curated',
    why: 'The distinct prompt versions this valuation’s AI runs used. `ai_prompt_versions` is written only by an administrator editing a prompt, and the `DISTINCT` collapses the join to one row per version — the catalogue’s size, not the engagement’s.',
  },
  'routes/scim.ts:users': {
    bound: 'scalar',
    why: 'A `count(*)` of SCIM-provisioned users, for the `totalResults` the SCIM list response must carry. One row.',
  },
  'routes/sensitivity.ts:valuation_params': {
    bound: 'key',
    why: 'The stored DLOM for one valuation. Unique on `valuation_id`.',
  },
};

/** Directories whose SQL is not about this service's own data. */
const OUT_OF_SCOPE = ['repos', 'db'];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (OUT_OF_SCOPE.includes(entry)) continue;
      sources(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Code only: these files discuss `SELECT` and `LIMIT` in prose constantly. */
function code(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
}

/**
 * `FROM <table>`, which is the half of a statement that names what it reads.
 *
 * A statement with no `FROM` — `SELECT 1`, `SELECT now()`, an advisory lock —
 * keys on `-`, which is how the scalar entries above read.
 */
function subjectOf(sql: string): string {
  return /\bFROM\s+([a-z_][a-z0-9_]*)/i.exec(sql)?.[1] ?? '-';
}

/** Every uncapped `SELECT` outside the repo layer, keyed `file:table`. */
function uncappedQueries(): string[] {
  const seen = new Map<string, number>();
  const found: string[] = [];
  for (const file of sources(SRC).sort()) {
    const src = code(readFileSync(file, 'utf8'));
    // Template literals and single-quoted strings: the two spellings a query
    // is written in here. Uppercase `SELECT` on purpose — every statement in
    // this service is written that way, and a lowercase match also finds the
    // string `'select'`, which is an intake question's input type.
    for (const m of src.matchAll(/(`[^`]*`|'(?:[^'\\\n]|\\.)*')/g)) {
      const sql = m[1]!.slice(1, -1);
      if (!/\bSELECT\b/.test(sql)) continue;
      if (/\bLIMIT\b/i.test(sql)) continue;
      const base = `${path.relative(SRC, file)}:${subjectOf(sql)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      found.push(n === 1 ? base : `${base}#${n}`);
    }
  }
  return found.sort();
}

describe('SQL outside the repo layer states what bounds it', () => {
  const queries = uncappedQueries();

  it('is reading the sources at all', () => {
    // The vacuity guard. Every regex here is over a shape this codebase
    // reformats — a query moved onto one line, a comment restyled — and the
    // census passes trivially the moment one of them stops firing.
    expect(sources(SRC).length).toBeGreaterThan(100);
    expect(queries.length).toBeGreaterThan(10);
    // And the population is the right one: a repo query is excluded because of
    // where it lives, not because the scan missed it.
    expect(sources(SRC).some((f) => f.includes(`${path.sep}repos${path.sep}`))).toBe(false);
    expect(queries).toContain('routes/branding.ts:partners');
  });

  it('has every uncapped statement accounted for', () => {
    expect(queries.filter((q) => !(q in BOUNDED))).toEqual([]);
  });

  it('accounts for nothing that has stopped being uncapped', () => {
    expect(Object.keys(BOUNDED).filter((k) => !queries.includes(k))).toEqual([]);
  });

  it('states a mechanism, not a hope, for every one', () => {
    const vague: string[] = [];
    for (const [key, entry] of Object.entries(BOUNDED)) {
      if (entry.why.trim().length < 40) vague.push(key);
      if (
        /\b(small|short|few|low) (enough|in practice)\b|\bunlikely to\b|\brarely\b|\bfor now\b|\bnobody has\b|\bin practice\b/i.test(
          entry.why,
        )
      )
        vague.push(key);
    }
    expect(vague).toEqual([]);
  });
});

describe('the two routes that read the spine take a page of it', () => {
  const read = (rel: string) => readFileSync(path.resolve(SRC, rel), 'utf8');

  it('bounds the client progress timeline and says when it is short', () => {
    // The finding this census was written for. `listEvents` with a type filter
    // and no limit is not a bounded read — the types it filters to are the
    // ones that grow with the work.
    const src = read('routes/progress.ts');
    expect(src).toContain('PROGRESS_TIMELINE_LIMIT + 1');
    expect(src).toContain('timeline_truncated');
    // And the stepper does not take that page: it needs the *first* entry into
    // each stage, and a page keeps the newest rows.
    expect(src).toContain('firstEntryPerState');
  });

  it('bounds the evidence bundle’s spine read at the audit trail’s own ceiling', () => {
    const src = read('routes/evidence.ts');
    expect(src).toContain('MAX_TRAIL_EVENTS + 1');
    // Two ceilings over one list would put a different history in
    // `events.json` and in the `audit-trail.json` beside it.
    expect(src).not.toMatch(/EVIDENCE_EVENT_LIMIT/);
    for (const flag of [
      'events: MAX_TRAIL_EVENTS',
      'review_tasks: EVIDENCE_ROW_LIMIT',
      'admin_events: EVIDENCE_ROW_LIMIT',
    ]) {
      expect(src).toContain(flag);
    }
  });
});
