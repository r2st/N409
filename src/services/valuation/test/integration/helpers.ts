import pg from 'pg';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { migrate } from '../../src/db/migrate.js';
import { attachPoolErrorHandler } from '../../src/db/pool.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createUser } from '../../src/repos/users.js';
import { invalidateValuation } from '../../src/repos/valuations.js';
import { hashPassword } from '../../src/auth/password.js';
import { newUlid } from '@n409/shared';
import type { RoleKey } from '../../src/domain/roles.js';

const BASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://n409:n409_dev@localhost:5432/n409_dev';

export async function isDbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: BASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

export interface TestDb {
  pool: pg.Pool;
  teardown: () => Promise<void>;
}

/**
 * Waits for the throwaway database's backends to actually go away.
 *
 * `pool.end()` resolves once every client has been *asked* to close: pg drops
 * each one from its list synchronously and fires the end callback from there,
 * while the sockets are still unwinding. So the `DROP DATABASE ... WITH (FORCE)`
 * that follows can still find a live backend, terminate it, and hand the
 * closing client a fatal 57P01 — which pg raises on the pool, not on any query.
 *
 * Polling until `pg_stat_activity` is clear means FORCE has nothing left to
 * kill in the ordinary case. Bounded, because a genuinely leaked connection
 * must not hang the suite; FORCE is still there to deal with one.
 */
async function waitForBackendsToExit(admin: pg.Client, dbName: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName],
    );
    if ((rows[0]?.n ?? 0) === 0 || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Creates a throwaway database, migrates it, and drops it on teardown. */
export async function setupTestDb(): Promise<TestDb> {
  const dbName = `n409_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(BASE_URL);
  url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  // Same reason as production (db/pool.ts): an idle client that dies raises
  // `error` on the pool, and an unhandled one takes the worker down with it.
  attachPoolErrorHandler(pool);
  await migrate(pool);

  return {
    pool,
    teardown: async () => {
      await pool.end();
      const drop = new pg.Client({ connectionString: BASE_URL });
      await drop.connect();
      try {
        await waitForBackendsToExit(drop, dbName);
        await drop.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await drop.end();
      }
    },
  };
}

export interface TestApp {
  app: FastifyInstance;
  pool: pg.Pool;
  teardown: () => Promise<void>;
}

/**
 * Intercept every query the app makes on this pool, pooled clients included.
 *
 * Several suites stage a race or a failure by replacing `pool.query`. That
 * reaches only the calls made directly on the pool: work done inside a
 * transaction runs on a client from `pool.connect()`, whose `query` is a
 * different function, so a hook installed the old way silently stopped firing
 * the moment a handler was moved into a transaction — and the test went on
 * passing, having staged nothing. (`recordPaidInvoice` is exactly that move.)
 *
 * `hook` is called with the SQL text before each query runs; return a value to
 * answer the query without touching the database, or `undefined` to let it
 * through. Returns a restore function.
 */
export function interceptPoolQueries(
  pool: pg.Pool,
  hook: (sql: string, phase: 'before' | 'after') => Promise<unknown> | unknown,
): () => void {
  const originalQuery = pool.query.bind(pool);
  const originalConnect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  const sqlOf = (arg: unknown) => (typeof arg === 'string' ? arg : ((arg as { text?: string })?.text ?? ''));

  const wrap =
    (run: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      const sql = sqlOf(args[0]);
      const short = await hook(sql, 'before');
      if (short !== undefined) return short;
      const result = await (run(...args) as Promise<unknown>);
      await hook(sql, 'after');
      return result;
    };

  (pool as unknown as { query: unknown }).query = wrap(originalQuery as (...a: unknown[]) => unknown);
  // Only the promise form is wrapped. `pool.query` itself checks a client out
  // through `pool.connect(callback)`, so wrapping the callback form would both
  // hook every query twice and — if the callback were dropped, as the obvious
  // `async () => …` replacement does — hang every `pool.query` in the process
  // forever.
  (pool as unknown as { connect: unknown }).connect = (...args: unknown[]) => {
    if (typeof args[0] === 'function') {
      return (originalConnect as unknown as (...a: unknown[]) => unknown)(...args);
    }
    return originalConnect().then((client) => {
      const clientQuery = client.query.bind(client);
      (client as unknown as { query: unknown }).query = wrap(clientQuery as (...a: unknown[]) => unknown);
      const release = client.release.bind(client);
      (client as unknown as { release: unknown }).release = (...a: unknown[]) => {
        (client as unknown as { query: unknown }).query = clientQuery;
        return (release as (...x: unknown[]) => unknown)(...a);
      };
      return client;
    });
  };

  return () => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    (pool as unknown as { connect: unknown }).connect = originalConnect;
  };
}

/**
 * Stands in for the AI/engine `/ready` probes. `status` drives every probe;
 * pass 503 (or throw) to model a downstream outage.
 */
export function stubReadinessFetch(status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify({ status: 'ready' }), { status })) as typeof fetch;
}

export async function setupTestApp(
  env: Record<string, string> = {},
  deps: Partial<Parameters<typeof buildApp>[0]> = {},
): Promise<TestApp> {
  const db = await setupTestDb();
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    JWT_SECRET: 'integration-test-secret-0123456789abcdef',
    LOG_LEVEL: 'silent',
    ...env,
  });
  const app = buildApp({
    config,
    pool: db.pool,
    // /ready probes the AI and engine services, which no integration suite runs.
    // Default them to "up" so only the tests that care about readiness have to
    // think about them; those pass their own readinessFetch below.
    readinessFetch: stubReadinessFetch(),
    ...deps,
  });
  await app.ready();
  return {
    app,
    pool: db.pool,
    teardown: async () => {
      await app.close();
      await db.teardown();
    },
  };
}

/** Registers a user with the given roles directly in the DB and returns a bearer token. */
export async function seedUser(
  ctx: TestApp,
  args: { email?: string; roles: RoleKey[]; partnerId?: string | null },
): Promise<{ id: string; email: string; token: string }> {
  const email = args.email ?? `${newUlid().toLowerCase()}@test.example.com`;
  const password = 'test-password-123';
  const user = await createUser(ctx.pool, {
    email,
    passwordDigest: await hashPassword(password),
    roles: args.roles,
    partnerId: args.partnerId ?? null,
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`seedUser login failed: ${res.body}`);
  return { id: user.id, email, token: res.json().token as string };
}

export async function seedPartner(ctx: TestApp, name: string): Promise<string> {
  const id = newUlid();
  await ctx.pool.query('INSERT INTO partners (id, name, key) VALUES ($1, $2, $3)', [
    id,
    name,
    name.toLowerCase().replace(/\s+/g, '-'),
  ]);
  return id;
}

export const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Puts an engagement in a state, for tests that need one in order to test
 * something else.
 *
 * A great many of these suites want an engagement sitting in `review` or
 * `drafted` and do not care how it got there, and the shortest way to arrange
 * that used to be a `PATCH { state }` — which worked because the PATCH route
 * accepted any state over any other. It does not any more: `domain/
 * transitionGuard.ts` refuses an edge the lifecycle table does not have, and
 * that refusal is the point of the guard, so the arrangements have to stop
 * relying on the hole.
 *
 * Walking the workflow for real is the wrong substitute. Reaching `drafted`
 * legally is six transitions, each firing the state-change hook, its
 * notification matrix, its partner webhooks and its outbox writes — arrangement
 * noise in every assertion downstream, and for `published` it also means a
 * signature and a QA review the test may have nothing to say about.
 *
 * So: write the column. This is `INSERT`-shaped setup, not an action under
 * test, and it deliberately writes nothing else — no `version` bump, no
 * `state_changed` event, no timestamp column. A test that cares about the
 * transition itself must go through the API, and the ones that do (workflow,
 * reviews, bulk, publish gate) still do.
 */
export async function forceState(ctx: TestApp, valuationId: string, state: string): Promise<void> {
  const { rowCount } = await ctx.pool.query(
    'UPDATE valuations SET state = $2::valuation_state WHERE id = $1',
    [valuationId, state],
  );
  if (rowCount !== 1) throw new Error(`forceState: no valuation ${valuationId}`);
  // `findValuationById` caches a row for five seconds, and an arrangement is
  // always immediately followed by the request it was arranging for. Every
  // production writer goes through `invalidateValuationAfter`; this one is
  // going around `patchValuation`, so it has to do that part itself.
  invalidateValuation(valuationId);
}

/**
 * What a rendered report says about itself, without decoding a single glyph.
 *
 * Reading the *prose* back out of one of these documents is real work — the
 * renderer compresses its content streams and embeds a subsetted Unicode face,
 * so the codes inside them are glyph indices that only the font's `/ToUnicode`
 * CMap can turn back into letters. `@n409/report`'s own suite does exactly that
 * against documents rendered with `compress: false`, and that is where
 * assertions about wording belong.
 *
 * Everything here is the other layer, and it is stored in the clear: the
 * document information dictionary, the tagged structure tree's chapter titles,
 * and the `/ActualText` spans. That layer is not a convenient proxy for the
 * page — it is the half of the document that search, copy-out and a screen
 * reader use, it is invisible on paper, and a report that lost it would look
 * perfect and be unreadable to anyone not looking at it. Cheap to assert, and
 * worth asserting on its own account.
 */
export interface PdfOutline {
  /** `/Title` — the authored report title. */
  title: string | null;
  /** `/Keywords` — company, kind, and the version this render came from. */
  keywords: string | null;
  /** Every `/Sect` element's `/T`: the chapter headings, as tagged. */
  headings: string[];
  /** Every `/ActualText` span — the cover fact block, as read aloud. */
  actualText: string[];
}

/**
 * One PDF literal string, as text.
 *
 * A writer may store a string either as PDFDocEncoded bytes or, the moment one
 * character will not fit in a byte, as UTF-16BE behind a byte-order mark — and
 * which one it picks is a property of the *content*, so a report whose chapter
 * happens to be titled with an en dash comes back in a different encoding from
 * the one beside it. Both forms have to be understood or the assertions become
 * accidentally sensitive to punctuation.
 */
function decodePdfString(body: string): string {
  const unescaped = body.replace(/\\([()\\])/g, '$1');
  if (!unescaped.startsWith('þÿ')) return unescaped;
  let out = '';
  for (let i = 2; i + 1 < unescaped.length; i += 2) {
    out += String.fromCharCode((unescaped.charCodeAt(i) << 8) | unescaped.charCodeAt(i + 1));
  }
  return out;
}

/** Literal-string bodies of the indirect objects, by object number. */
function pdfStringObjects(raw: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of raw.matchAll(/(?:^|\n)(\d+) 0 obj\s*\(([\s\S]*?)\)\s*endobj/g)) {
    found.set(m[1]!, decodePdfString(m[2]!));
  }
  return found;
}

export function pdfOutline(pdf: Buffer): PdfOutline {
  const raw = pdf.toString('latin1');
  const strings = pdfStringObjects(raw);

  // The information dictionary holds indirect references, never inline strings,
  // so `/Title 33 0 R` is the only `/Title` that takes an object number — the
  // structure tree's `/S /Title` role cannot be confused for it.
  const infoValue = (key: string): string | null => {
    const ref = new RegExp(`/${key} (\\d+) 0 R`).exec(raw)?.[1];
    return ref ? (strings.get(ref) ?? null) : null;
  };

  const inlineStrings = (pattern: RegExp): string[] =>
    Array.from(raw.matchAll(pattern), (m) => decodePdfString(m[1]!));

  return {
    title: infoValue('Title'),
    keywords: infoValue('Keywords'),
    headings: inlineStrings(/\/S \/Sect[^>]*?\/T \(((?:[^()\\]|\\.)*)\)/g),
    actualText: inlineStrings(/\/ActualText \(((?:[^()\\]|\\.)*)\)/g),
  };
}
