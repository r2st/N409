import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { signCapTableSyncState } from '../../src/auth/jwt.js';
import { providerRefused } from '../../src/clients/deadline.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What a third-party integration is allowed to make this service say (round
 * 175, methodology M5).
 *
 * `IntegrationError` exists so a route can echo a caught message: the type is
 * the statement that the wording names a provider and a status and nothing
 * else. `routes/hris.ts` was converted to it when it was introduced. The two
 * routes beside it were not, and both were still
 *
 *     const message = err instanceof Error ? err.message : String(err);
 *     throw problems.unprocessable(`Sync failed: ${message}`);
 *
 * which forwards whatever reached it. For the cap-table pull that is the whole
 * sync — `saveCapTable` and `recordSync` are inside the `try` — so a row
 * Postgres refused answered the analyst with the driver's wording, its
 * constraint name, and in `err.detail` the values it rejected.
 *
 * `errorBodyDisclosure.test.ts` is the census written for exactly this line and
 * it reported success on both of them for four rounds, because binding the
 * message to a local one statement earlier puts it outside the argument the
 * scan reads. That blind spot is closed in the same round; these are the
 * behavioural half.
 */

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('providerRefused', () => {
  it('reads a rate limit as a time to come back, not as a broken integration', () => {
    // The whole point: "Carta cap-table fetch failed (429)" reads like a fault
    // and prompts the one response that makes it worse, which is clicking Sync
    // again immediately.
    const limited = providerRefused('Carta', 'cap-table fetch', {
      status: 429,
      headers: new Headers({ 'retry-after': '90' }),
    });
    expect(limited.name).toBe('IntegrationError');
    expect(limited.message).toBe('Carta is rate-limiting us — try again in about 90s.');
  });

  it('says something useful when the provider named no interval', () => {
    const limited = providerRefused('Pulley', 'cap-table fetch', {
      status: 429,
      headers: new Headers(),
    });
    expect(limited.message).toMatch(/rate-limiting us/);
    expect(limited.message).not.toMatch(/NaN|undefined|null/);
  });

  it('honours an HTTP-date Retry-After, and refuses an absurd one', () => {
    const soon = new Date(Date.now() + 120_000).toUTCString();
    expect(
      providerRefused('Carta', 'x', { status: 429, headers: new Headers({ 'retry-after': soon }) }).message,
    ).toMatch(/about 1[12]\ds\./);
    // A provider asking us to wait a week is capped rather than echoed.
    expect(
      providerRefused('Carta', 'x', {
        status: 429,
        headers: new Headers({ 'retry-after': String(7 * 24 * 3600) }),
      }).message,
    ).toBe('Carta is rate-limiting us — try again in about 21600s.');
  });

  it('leaves every other status with the wording the connection log records', () => {
    // Deliberately unchanged: this string is what `last_error` has held for the
    // life of these integrations, and several tests read it.
    expect(providerRefused('Carta', 'cap-table fetch', { status: 503, headers: new Headers() }).message).toBe(
      'Carta cap-table fetch failed (503)',
    );
  });
});

describe.skipIf(!dbUp)('a cap-table sync failure carries only wording we authored', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  /** What the Carta capitalization endpoint answers with on the next pull. */
  let capResponse: () => Response = () => jsonResponse({ companyName: 'Acme Inc', shareClasses: [] });

  beforeAll(async () => {
    ctx = await setupTestApp(
      { CARTA_CLIENT_ID: 'cid', CARTA_CLIENT_SECRET: 'csecret', AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' },
      {
        capTableSyncFetch: vi.fn(async (url: string | URL | Request) => {
          const u = String(url);
          if (u.includes('/oauth/token')) {
            return jsonResponse({ access_token: 'tok', expires_in: 3600, company_id: 'co_1' });
          }
          if (u.includes('/capitalization')) return capResponse();
          throw new Error(`unexpected fetch ${u}`);
        }) as unknown as typeof fetch,
      },
    );
    ops = await seedUser(ctx, { roles: ['valuation_user'] });
    const valuation = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Acme Inc', userId: ops.id },
      { actorType: 'human', actorId: ops.id, source: 'test' },
    );
    valuationId = valuation.id;

    const state = await signCapTableSyncState(
      { valuationId, provider: 'carta', userId: ops.id },
      { secret: 'integration-test-secret-0123456789abcdef', issuer: 'n409', ttlSeconds: 3600 },
    );
    const connected = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/cap-table-sync/callback?state=${encodeURIComponent(state)}&code=abc&company_id=co_1`,
    });
    expect(connected.statusCode).toBe(302);
  });
  afterAll(async () => ctx?.teardown());

  const pull = () =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/cap-table/sync/carta/pull`,
      headers: authHeader(ops.token),
      payload: { apply: true },
    });

  it('passes a provider refusal through, because that wording is ours to publish', async () => {
    capResponse = () => jsonResponse({ error: 'nope' }, 503);
    const res = await pull();
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe('Sync failed: Carta cap-table fetch failed (503)');
  });

  it('tells the analyst when Carta is rate-limiting rather than failing', async () => {
    capResponse = () => jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '30' });
    expect((await pull()).json().detail).toBe(
      'Sync failed: Carta is rate-limiting us — try again in about 30s.',
    );
  });

  it('publishes nothing from a failure it did not author', async () => {
    // A database error from inside the sync — the case the old catch could not
    // tell from a provider's. Simulated by making the pull throw the shape `pg`
    // produces: a message naming a constraint, and values on `detail`.
    const boom = Object.assign(
      new Error('duplicate key value violates unique constraint "cap_table_entries_valuation_class_idx"'),
      {
        code: '23505',
        severity: 'ERROR',
        constraint: 'cap_table_entries_valuation_class_idx',
        detail: 'Key (security_class)=(Series A) already exists.',
      },
    );
    capResponse = () => {
      throw boom;
    };
    const res = await pull();
    expect(res.statusCode).toBe(422);
    const body = JSON.stringify(res.json());
    expect(body).not.toContain('cap_table_entries_valuation_class_idx');
    expect(body).not.toContain('Series A');
    expect(body).not.toContain('duplicate key');
    // Still says which provider and where to look, so the answer is not merely
    // safe but usable.
    expect(res.json().detail).toBe("Carta sync failed — the details are in the connection's last error");
  });

  it('withholds it from the connection column too, and says where it went', async () => {
    /**
     * This asserted `last_error` contained "duplicate key" — the fix's own
     * promise that the withheld wording was still *somewhere*, made when the
     * column was the somewhere. R257 took it out of there as well, and for the
     * same reason the body lost it: `toPublic` returns `last_error` verbatim
     * and the card draws it, so the column is a second door to the same
     * screen, not a private note. The assertion was left pointing at the old
     * behaviour.
     *
     * The promise still has to hold, and where R257 moved it is the log line,
     * which carries `err` intact — at the level the failure earned since R258.
     * That half is asserted in `test/unit/connectorSyncLog.test.ts`, where the
     * logger can be seen: the one here is a Fastify child, and a spy on
     * `app.log` never sees a child's writes.
     */
    const { rows } = await ctx.pool.query<{ last_error: string | null }>(
      'SELECT last_error FROM cap_table_connections WHERE valuation_id = $1',
      [valuationId],
    );
    expect(rows[0]?.last_error).not.toContain('duplicate key');
    expect(rows[0]?.last_error).not.toContain('cap_table_entries_valuation_class_idx');
    expect(rows[0]?.last_error).toContain('service log');
  });
});
