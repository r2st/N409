import { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import { newUlid } from '@n409/shared';
import type pg from 'pg';

const dbUp = await isDbAvailable();

/**
 * The two ids an ops user may put in a create body.
 *
 * `POST /api/v1/valuations` lets operations create on behalf of a client and
 * attach a partner. Both columns are the `ulid` domain — migration 0001 —
 * with foreign keys to `users` and `partners`, so each field had two ways of
 * being wrong and both ended at the same place: the INSERT. A string that is
 * not a ULID is `value for domain ulid violates check constraint`; one that is
 * a ULID and names nobody is a foreign key violation. Neither is a fault of
 * this service, and both arrived as a 500 with no field named.
 *
 * The same sentence is already written two rows below in the file, about
 * `assigned_reviewer_id` on the *patch* body — "shape here, existence in the
 * handler". It was applied to the door that edits the row and not to the one
 * that creates it.
 */
describe.skipIf(!dbUp)('POST /valuations refuses an id it cannot use', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  /** Well-formed, and names nothing in this database. */
  const ULID_ABSENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    await app.ready();
    const ctx = { app, pool, teardown: async () => {} };
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  });

  const create = (token: string, over: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { company_name: 'Acme, Inc.', kind: '409a', ...over },
    });

  it('still creates for the ops user with a real client id', async () => {
    const res = await create(ops.token, { user_id: client.id });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().valuation.user_id).toBe(client.id);
  });

  it('names the field for an id that is not a ULID, instead of 500ing on the domain', async () => {
    for (const field of ['user_id', 'partner_id']) {
      const res = await create(ops.token, { [field]: 'not-a-ulid' });
      expect(res.statusCode, `${field}: ${res.body}`).toBe(422);
      expect(res.json().errors?.[0]?.path).toEqual([field]);
    }
  });

  it('names the field for a well-formed id that names nobody', async () => {
    const user = await create(ops.token, { user_id: ULID_ABSENT });
    expect(user.statusCode, user.body).toBe(422);
    expect(user.json().detail).toBe('Unknown user');
    expect(user.json().errors?.[0]?.path).toEqual(['user_id']);

    const partner = await create(ops.token, { partner_id: ULID_ABSENT });
    expect(partner.statusCode, partner.body).toBe(422);
    expect(partner.json().detail).toBe('Unknown partner');
    expect(partner.json().errors?.[0]?.path).toEqual(['partner_id']);
  });

  it('refuses an archived firm on both the ops field and the member path', async () => {
    /*
     * R348. The comment beside these checks claims the shape
     * `assertAssignablePartner` uses "for the same two columns", and that
     * helper has two refusals: unknown, and — under "new partner assignments
     * must reference a live (non-archived) partner" — archived. Only the first
     * was copied, so `partners.archived_at` did nothing at the door that files
     * the work. `convertIntakeLink` states the rule this breaks in a sentence:
     * "a withdrawn firm acquiring fresh work is the thing being prevented".
     *
     * Both paths, because archiving a firm does not sign its people out and
     * their own `principal.partnerId` is what the row is written with when ops
     * names nothing.
     */
    const partnerId = newUlid();
    await pool.query('INSERT INTO partners (id, name, key, archived_at) VALUES ($1, $2, $3, now())', [
      partnerId,
      'Withdrawn Advisors',
      `withdrawn-${partnerId.toLowerCase()}`,
    ]);
    const member = await seedUser(
      { app, pool, teardown: async () => {} },
      { roles: ['partner'], partnerId },
    );

    const named = await create(ops.token, { partner_id: partnerId });
    expect(named.statusCode, named.body).toBe(422);
    expect(named.json().detail).toBe('This partner is archived');
    expect(named.json().errors?.[0]?.path).toEqual(['partner_id']);

    // The member names no field — the fault is their firm, not their body — so
    // this is a conflict about the firm rather than a 422 about a parameter.
    const own = await create(member.token, {});
    expect(own.statusCode, own.body).toBe(409);
    expect(own.json().detail).toMatch(/withdrawn/i);

    // Nothing was filed under the withdrawn firm either way.
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM valuations WHERE partner_id = $1',
      [partnerId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('still creates under a firm that is restored', async () => {
    const partnerId = newUlid();
    await pool.query('INSERT INTO partners (id, name, key, archived_at) VALUES ($1, $2, $3, now())', [
      partnerId,
      'Back Again LLP',
      `back-${partnerId.toLowerCase()}`,
    ]);
    expect((await create(ops.token, { partner_id: partnerId })).statusCode).toBe(422);
    // Archiving is a boolean an administrator can set back, so the refusal has
    // to be a refusal and not a one-way door.
    await pool.query('UPDATE partners SET archived_at = NULL WHERE id = $1', [partnerId]);
    const res = await create(ops.token, { partner_id: partnerId });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().valuation.partner_id).toBe(partnerId);
  });

  it('refuses a malformed id on the client path too, where it was only ignored', async () => {
    // A non-ops caller always creates for themselves, so their `user_id` is
    // never read — a junk one used to be dropped on the floor under a 201. The
    // schema is the same schema for every caller, so it is a 422 now. Stated
    // here because it is a behaviour change on the path that is not the bug:
    // saying "this field is not a valid id" beats accepting a body whose field
    // meant nothing.
    const res = await create(client.token, { user_id: 'not-a-ulid' });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().errors?.[0]?.path).toEqual(['user_id']);
  });

  it('creates no row when the id is refused', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM valuations');
    await create(ops.token, { user_id: ULID_ABSENT });
    await create(ops.token, { partner_id: 'not-a-ulid' });
    const after = await pool.query('SELECT count(*)::int AS n FROM valuations');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
