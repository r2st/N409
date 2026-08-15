import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { newUlid } from '@n409/shared';
import { migrate } from '../../src/db/migrate.js';
import { loadConfig } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import { firePartnerWebhooks } from '../../src/hooks/partnerWebhooks.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What a transition does when the announcement of it cannot be written.
 *
 * Every caller of `onStateChanged` commits the state change first and announces
 * it after — `patchValuation` has already returned by the time the hook runs.
 * So a throw out of the hook cannot undo anything; it can only misreport a
 * transition that succeeded, and the notification it failed to queue is gone
 * either way because nothing re-derives an announcement nobody recorded as owed.
 *
 * The webhook half of the hook had been contained on that reasoning since it was
 * written. The email and notification half had not, and it is the half with four
 * database round trips standing in front of the write that makes it durable.
 *
 * The Stripe path is the one that shows why this had to be a fix rather than a
 * note. `recordStripeEvent` is deliberately skipped on the throw path so a
 * failed event is redelivered — but the redelivery re-enters `fulfill()`, finds
 * `paid_status` already `paid`, skips the block, and settles the event as
 * handled. The retry that exists to recover the notification is what buries it.
 */
describe.skipIf(!dbUp)('state change notification failures', () => {
  let db: TestDb;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  /**
   * Statements the app's pool should refuse, as a substring match. Reassigned
   * per test; `null` lets everything through.
   *
   * A predicate rather than "the database is down" because the point is a
   * transient blip on one statement while the transition either side of it
   * commits — a database that is wholly down never gets as far as a state
   * change to announce.
   */
  let failWhen: ((sql: string) => boolean) | null = null;

  /**
   * The app's pool: the real one, with `failWhen` in front of every statement.
   *
   * Clients are wrapped in a Proxy rather than patched, because a checked-out
   * client returns to the real pool on release and a patched `query` would
   * follow it there and break unrelated work later in the file.
   */
  const flakyPool = (real: pg.Pool): pg.Pool => {
    const sqlOf = (arg: unknown) =>
      typeof arg === 'string' ? arg : ((arg as { text?: string } | null)?.text ?? '');
    const guard = (arg: unknown) => {
      if (failWhen?.(sqlOf(arg))) throw new Error('connection terminated unexpectedly');
    };
    return {
      query: (...args: unknown[]) => {
        guard(args[0]);
        return (real.query as (...a: unknown[]) => unknown)(...args);
      },
      connect: async () => {
        const c = await real.connect();
        return new Proxy(c, {
          get(target, prop) {
            if (prop === 'query') {
              return (...args: unknown[]) => {
                guard(args[0]);
                return (target.query as (...a: unknown[]) => unknown)(...args);
              };
            }
            const value = Reflect.get(target, prop) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    } as unknown as pg.Pool;
  };

  const newValuation = async (): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'NotifyCo' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  /** `pending → started`, the transition that emails the owner. */
  const advance = (id: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/workflow/advance`,
      headers: authHeader(ops.token),
    });

  const stateOf = async (id: string): Promise<string> => {
    const { rows } = await pool.query<{ state: string }>('SELECT state FROM valuations WHERE id = $1', [id]);
    return rows[0]!.state;
  };

  const outboxFor = async (id: string) => {
    const { rows } = await pool.query('SELECT * FROM email_outbox WHERE valuation_id = $1', [id]);
    return rows;
  };

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
    // Seeding and assertions go through the real pool; only the app sees the
    // flaky one, so arranging a test cannot trip its own injected failure.
    app = buildApp({ config, pool: flakyPool(pool) });
    await app.ready();
    const ctx = { app, pool, teardown: async () => {} };
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  });

  beforeEach(() => {
    failWhen = null;
  });

  it('queues the transition email when nothing is failing', async () => {
    // The control. Everything below asserts that a failure is contained, and
    // containment is indistinguishable from a hook that quietly does nothing
    // unless the working path is pinned too.
    const id = await newValuation();
    expect((await advance(id)).statusCode).toBe(200);
    expect(await stateOf(id)).toBe('started');
    const queued = await outboxFor(id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.template_key).toBe('valuation_started');
  });

  it('answers the transition honestly when the outbox write fails', async () => {
    const id = await newValuation();
    failWhen = (sql) => sql.includes('INSERT INTO email_outbox');

    // This is the regression. The transition committed inside `patchValuation`
    // before the hook ran, so a 500 here describes a state change that did in
    // fact happen — and tells the caller to retry a move already applied.
    const res = await advance(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.state).toBe('started');
    expect(await stateOf(id)).toBe('started');

    // The message really was lost; containment makes that legible, not untrue.
    expect(await outboxFor(id)).toHaveLength(0);
  });

  it('contains a failure in the reads that run before the outbox write', async () => {
    // Four round trips stand between the committed transition and the write
    // that makes the message durable — the template overrides, the partner row,
    // the recipients, and their channel preferences. Any of them is the window.
    const id = await newValuation();
    failWhen = (sql) => sql.includes('FROM communication_templates');

    const res = await advance(id);
    expect(res.statusCode).toBe(200);
    expect(await stateOf(id)).toBe('started');
    expect(await outboxFor(id)).toHaveLength(0);
  });

  it('contains a failure in the notification write', async () => {
    // `completed → review` addresses the *reviewer*, with an in-app
    // notification beside the email — so the engagement needs one assigned or
    // both specs are skipped for want of a recipient and the injected failure
    // never runs.
    const id = await newValuation();
    await pool.query(
      `UPDATE valuations SET state = 'completed', assigned_reviewer_id = $2 WHERE id = $1`,
      [id, ops.id],
    );
    failWhen = (sql) => sql.includes('INSERT INTO notifications');

    const res = await advance(id);
    expect(res.statusCode).toBe(200);
    expect(await stateOf(id)).toBe('review');

    // The email and the notification share one transaction, so the failed
    // notification takes the outbox row with it. Both are owed and neither was
    // written — which is the loss this contains rather than repairs.
    expect(await outboxFor(id)).toHaveLength(0);
    const { rows: notes } = await pool.query('SELECT * FROM notifications WHERE valuation_id = $1', [id]);
    expect(notes).toHaveLength(0);
  });

  it('writes the reviewer email and notification together when nothing fails', async () => {
    // The control for the pair above: without it, the assertions there are also
    // satisfied by a hook that never addressed the reviewer at all.
    const id = await newValuation();
    await pool.query(
      `UPDATE valuations SET state = 'completed', assigned_reviewer_id = $2 WHERE id = $1`,
      [id, ops.id],
    );

    expect((await advance(id)).statusCode).toBe(200);
    const queued = await outboxFor(id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.template_key).toBe('review_needed');
    const { rows: notes } = await pool.query('SELECT * FROM notifications WHERE valuation_id = $1', [id]);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe('review_needed');
  });

  it('leaves the next transition working after one was not announced', async () => {
    // A contained failure must not leave anything half-held — an open
    // transaction or a checked-out client would surface here rather than above.
    const id = await newValuation();
    failWhen = (sql) => sql.includes('INSERT INTO email_outbox');
    expect((await advance(id)).statusCode).toBe(200);

    failWhen = null;
    const res = await advance(id);
    expect(res.statusCode).toBe(200);
    expect(await stateOf(id)).toBe('onboarding_completed');
    expect(await outboxFor(id)).toHaveLength(0); // onboarding_completed emails nobody
  });
});

/**
 * The fan-out half: one partner's webhook failing to record must not decide
 * whether the partner's other webhooks hear about the event.
 *
 * `postDelivery` never throws, so the only thing that can raise inside the loop
 * is the database write either side of it — and an aborted fan-out is not a
 * delayed delivery for the webhooks it never reached. The retry sweep works from
 * delivery rows, and a `recordDelivery` that failed left none, so there is
 * nothing anywhere recording that those receivers were owed the event.
 */
describe.skipIf(!dbUp)('partner webhook fan-out failures', () => {
  let db: TestDb;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let receiver: FastifyInstance;
  let receiverUrl: string;
  let partnerId: string;
  let valuationId: string;
  /** Delivery-row inserts seen so far, so a test can fail only the first. */
  let inserts = 0;
  let failInsert: ((n: number) => boolean) | null = null;

  const flakyPool = (real: pg.Pool): pg.Pool => {
    const sqlOf = (arg: unknown) =>
      typeof arg === 'string' ? arg : ((arg as { text?: string } | null)?.text ?? '');
    const guard = (arg: unknown) => {
      if (!sqlOf(arg).includes('INSERT INTO partner_webhook_deliveries')) return;
      inserts += 1;
      if (failInsert?.(inserts)) throw new Error('connection terminated unexpectedly');
    };
    return {
      query: (...args: unknown[]) => {
        guard(args[0]);
        return (real.query as (...a: unknown[]) => unknown)(...args);
      },
      connect: () => real.connect(),
    } as unknown as pg.Pool;
  };

  const addWebhook = async (): Promise<string> => {
    const id = newUlid();
    await pool.query(
      `INSERT INTO partner_webhooks (id, partner_id, url, secret, events)
       VALUES ($1, $2, $3, 'shhh', '{}')`,
      [id, partnerId, receiverUrl],
    );
    return id;
  };

  const deliveriesFor = async (webhookId: string) => {
    const { rows } = await pool.query('SELECT * FROM partner_webhook_deliveries WHERE webhook_id = $1', [
      webhookId,
    ]);
    return rows;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
    });
    app = buildApp({ config, pool });
    await app.ready();

    // A receiver that answers, so a delivery that is attempted succeeds and the
    // rows below separate "never attempted" from "attempted and failed".
    receiver = Fastify();
    receiver.post('/hook', async () => ({ ok: true }));
    await receiver.listen({ port: 0, host: '127.0.0.1' });
    const addr = receiver.server.address();
    receiverUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/hook`;

    const ctx = { app, pool, teardown: async () => {} };
    partnerId = await seedPartner(ctx, 'Fan Out Partners');
    const owner = await seedUser(ctx, { roles: ['valuation_user'], partnerId });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'FanOutCo' },
    });
    valuationId = created.json().valuation.id;
    await pool.query('UPDATE valuations SET partner_id = $2 WHERE id = $1', [valuationId, partnerId]);
  });

  afterAll(async () => {
    await receiver?.close();
    await app?.close();
    await db?.teardown();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM partner_webhook_deliveries');
    await pool.query('DELETE FROM partner_webhooks');
    inserts = 0;
    failInsert = null;
  });

  it('delivers to every subscribed webhook', async () => {
    const [a, b, c] = [await addWebhook(), await addWebhook(), await addWebhook()];
    await firePartnerWebhooks({ pool, allowPrivateTargets: true }, partnerId, 'valuation.state_changed', {
      id: valuationId,
      number: 1,
      kind: '409a',
      state: 'started',
      company_name: 'FanOutCo',
    });
    for (const id of [a, b, c]) expect(await deliveriesFor(id)).toHaveLength(1);
  });

  it('keeps delivering after one webhook cannot be recorded', async () => {
    const [a, b, c] = [await addWebhook(), await addWebhook(), await addWebhook()];
    failInsert = (n) => n === 1;

    await firePartnerWebhooks(
      { pool: flakyPool(pool), allowPrivateTargets: true },
      partnerId,
      'valuation.state_changed',
      { id: valuationId, number: 1, kind: '409a', state: 'started', company_name: 'FanOutCo' },
    );

    // The first is genuinely lost — no row exists, so the retry sweep has
    // nothing to find, which is exactly why the loop must not stop here.
    expect(await deliveriesFor(a)).toHaveLength(0);
    // These two are the regression: under the old loop the throw left them
    // with no delivery row and no record that they were owed the event.
    expect(await deliveriesFor(b)).toHaveLength(1);
    expect(await deliveriesFor(c)).toHaveLength(1);
  });

  it('does not throw out of the fan-out when every webhook fails', async () => {
    // `onStateChanged` swallows what escapes here, so an uncontained throw
    // would be invisible rather than loud — worth pinning at this level.
    const [a, b] = [await addWebhook(), await addWebhook()];
    failInsert = () => true;

    await expect(
      firePartnerWebhooks(
        { pool: flakyPool(pool), allowPrivateTargets: true },
        partnerId,
        'valuation.state_changed',
        { id: valuationId, number: 1, kind: '409a', state: 'started', company_name: 'FanOutCo' },
      ),
    ).resolves.toBeUndefined();

    expect(await deliveriesFor(a)).toHaveLength(0);
    expect(await deliveriesFor(b)).toHaveLength(0);
    // Both were attempted, rather than the loop dying on the first.
    expect(inserts).toBe(2);
  });
});
