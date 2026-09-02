import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createUnsubscribeToken } from '../../src/domain/unsubscribeToken.js';
import { registerUnsubscribeRoutes } from '../../src/routes/unsubscribe.js';

/**
 * An unsubscribe that was not applied is lost, not delayed (R352, M5).
 *
 * The POST answers 200 whatever happens, and it has to: a provider that gets a
 * non-2xx may conclude the sender does not honour one-click and stop showing
 * the button at all. But the 200 is also the end of the request's life. Gmail
 * and Yahoo issue it once, from their own infrastructure, and read the 2xx as
 * the unsubscribe having been honoured — there is no redelivery, the recipient
 * is never told, and nothing here queues a second attempt.
 *
 * So a busy pool for one second left a person who asked to stop hearing from
 * us still on the list, with `warn` as the only trace — the level that in this
 * estate means *a retry is coming*. What happens next is a spam report against
 * the sending domain, and nothing joins it to the line.
 *
 * `logUnretried` is the vocabulary for that: `alert: true`, `retried: false`,
 * and a classified `failure_reason` rather than the error's own sentence. See
 * [[n409-announcement-loss-level]] and [[n409-alert-contract]].
 */

const SECRET = 'unit-test-secret-0123456789abcdefghij';
const TOKEN = createUnsubscribeToken({ userId: '01JUSERAAAAAAAAAAAAAAAAAAA', scope: 'marketing' }, SECRET);

type Line = { obj: Record<string, unknown>; msg: string };

async function buildApp(
  failure: Error = Object.assign(new Error('remaining connection slots are reserved'), { code: '53300' }),
): Promise<{ app: FastifyInstance; errors: Line[]; warns: Line[] }> {
  const errors: Line[] = [];
  const warns: Line[] = [];
  const app = Fastify({ logger: false });
  const capture = {
    error: (obj: Record<string, unknown>, msg: string) => void errors.push({ obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => void warns.push({ obj, msg }),
  };
  Object.assign(app.log, capture);
  app.addHook('onRequest', (req, _reply, done) => {
    req.log = { ...req.log, ...capture } as typeof req.log;
    done();
  });
  // Every write refused, which is the only way `apply` throws: the token
  // checks are pure and answer `false` rather than raising.
  const pool = { query: async () => { throw failure; } } as unknown as pg.Pool;
  registerUnsubscribeRoutes(app, { pool, secret: SECRET });
  await app.ready();
  return { app, errors, warns };
}

describe('a one-click unsubscribe that could not be applied', () => {
  it('still answers 200, so the provider keeps offering the button', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/unsubscribe?token=${encodeURIComponent(TOKEN)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unsubscribed: false });
    await app.close();
  });

  it('records it as lost rather than as something a retry will take', async () => {
    const { app, errors, warns } = await buildApp();
    await app.inject({
      method: 'POST',
      url: `/api/v1/unsubscribe?token=${encodeURIComponent(TOKEN)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });

    expect(warns).toEqual([]);
    expect(errors).toHaveLength(1);
    const [line] = errors;
    expect(line!.obj).toMatchObject({ alert: true, retried: false });
    // The classified token, not the driver's sentence.
    expect(line!.obj.failure_reason).toBe('pg.53300');
    expect(line!.msg).toContain('will not be retried');
    await app.close();
  });
});

describe('the footer link a person clicks', () => {
  const get = async (failure?: Error) => {
    const built = await buildApp(failure);
    const res = await built.app.inject({
      method: 'GET',
      url: `/api/v1/unsubscribe?token=${encodeURIComponent(TOKEN)}`,
    });
    await built.app.close();
    return { ...built, res };
  };

  it('tells the reader nothing worked, so this half really is retriable', async () => {
    const { res, warns, errors } = await get();
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('Please try again');
    // A busy pool: the reader clicking again is the retry, so `warn` is right.
    expect(errors).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toMatchObject({ failure_kind: 'transient', failure_reason: 'pg.53300' });
  });

  it('alerts on a permanent cause instead of sitting at warn beside the transient ones', async () => {
    // The shape the flat `warn` hid: a column that no longer exists refuses
    // every unsubscribe on the estate, identically, for as long as it is
    // deployed, and used to log at the same level as one busy second.
    const broken = Object.assign(new Error('column "email" does not exist'), { code: '42703' });
    const { res, warns, errors } = await get(broken);
    expect(res.statusCode).toBe(500);
    expect(warns).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.obj).toMatchObject({ alert: true, failure_reason: 'pg.42703' });
  });
});
