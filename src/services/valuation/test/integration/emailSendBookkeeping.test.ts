import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { interceptPoolQueries, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { onStateChanged } from '../../src/hooks/stateChange.js';
import { retryFailedEmails } from '../../src/hooks/emailRetry.js';
import { sendTransactionalEmail } from '../../src/email/transactional.js';
import { enqueueEmail, type EmailOutboxRow } from '../../src/repos/emailOutbox.js';

const dbUp = await isDbAvailable();

/**
 * What the outbox says about a message the relay already accepted.
 *
 * Every send path on this service is transport-then-bookkeeping: hand the row
 * to the transport, then write down what happened. The two live inside one
 * `try`, so a database failure on the *second* step is caught by a handler that
 * can only describe failures of the first — and it says the send failed.
 *
 * That is not a cosmetic mislabel. 'failed' is the retry ladder's entry
 * condition (0159): the row is stamped with a `next_attempt_at` a few minutes
 * out and the sweep delivers it again. So a blip on one UPDATE turns a
 * delivered message into a duplicate, and leaves the outbox — the platform's
 * record of what it sent — swearing the send failed. Mail cannot be un-sent.
 *
 * The failure is staged as a blip on one statement rather than a dead database,
 * because a dead database fails the recovery write too and the row simply stays
 * 'queued'. One refused UPDATE with a healthy pool either side of it is the
 * shape that actually reaches production: a statement timeout, a dropped
 * backend, a failover that costs one connection.
 */
describe.skipIf(!dbUp)('outbox bookkeeping after a successful send', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let restore: (() => void) | null = null;

  /** Sends recorded by the stub transport, oldest first. */
  let sent: string[] = [];
  const transport = {
    send: async (email: EmailOutboxRow) => {
      sent.push(email.id);
    },
  };

  /** Refuses the first `times` statements whose SQL contains `needle`. */
  const failFirst = (needle: string, times = 1): void => {
    let left = times;
    restore = interceptPoolQueries(pool, (sql, phase) => {
      if (phase === 'before' && sql.includes(needle) && left > 0) {
        left -= 1;
        throw new Error('connection terminated unexpectedly');
      }
      return undefined;
    });
  };

  const newValuation = async (): Promise<{
    id: string;
    kind: string;
    company_name: string;
    user_id: string;
    assigned_reviewer_id: string | null;
  }> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { kind: '409a', company_name: 'BookkeepingCo' },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().valuation.id as string;
    return { id, kind: '409a', company_name: 'BookkeepingCo', user_id: owner.id, assigned_reviewer_id: null };
  };

  const rowFor = async (id: string): Promise<EmailOutboxRow> => {
    const { rows } = await pool.query<EmailOutboxRow>('SELECT * FROM email_outbox WHERE id = $1', [id]);
    return rows[0]!;
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    pool = ctx.pool;
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);

  afterEach(() => {
    restore?.();
    restore = null;
    sent = [];
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('does not record a workflow email as failed when only the marking failed', async () => {
    const valuation = await newValuation();
    failFirst('UPDATE email_outbox');

    await onStateChanged({ pool, transport, log: undefined }, valuation, 'started');

    const { rows } = await pool.query<EmailOutboxRow>('SELECT * FROM email_outbox WHERE valuation_id = $1', [
      valuation.id,
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The transport took it exactly once, and said so.
    expect(sent).toEqual([row.id]);
    // So the one thing the row must not say is that the send failed — that is
    // the ladder's entry condition, and the ladder would send it again.
    expect(row.status).not.toBe('failed');
    expect(row.next_attempt_at).toBeNull();
  });

  it('does not record a transactional email as failed when only the marking failed', async () => {
    failFirst('UPDATE email_outbox');

    await sendTransactionalEmail(
      { pool, transport },
      {
        toUserId: owner.id,
        toEmail: owner.email,
        templateKey: 'password_reset',
        subject: 'Reset your password',
        body: 'Follow the link.',
      },
    );

    expect(sent).toHaveLength(1);
    const row = await rowFor(sent[0]!);
    expect(row.status).not.toBe('failed');
    expect(row.next_attempt_at).toBeNull();
  });

  it('does not record a retried email as failed when only the settle failed', async () => {
    const queued = await enqueueEmail(pool, {
      toUserId: owner.id,
      toEmail: owner.email,
      templateKey: 'valuation_started',
      subject: 'Queued',
      body: 'Body',
    });
    // Age it past the claim lease so the sweep treats it as stranded.
    await pool.query(`UPDATE email_outbox SET created_at = now() - interval '1 hour' WHERE id = $1`, [
      queued.id,
    ]);

    failFirst('UPDATE email_outbox\n     SET status');
    const result = await retryFailedEmails({ pool, transport });

    expect(result.attempted).toBe(1);
    expect(sent).toEqual([queued.id]);
    const row = await rowFor(queued.id);
    expect(row.status).not.toBe('failed');
    expect(row.next_attempt_at).toBeNull();
  });

  it('finishes the rest of a claimed batch when one settle fails', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const row = await enqueueEmail(pool, {
        toUserId: owner.id,
        toEmail: owner.email,
        templateKey: 'valuation_started',
        subject: `Batch ${i}`,
        body: 'Body',
      });
      ids.push(row.id);
    }
    await pool.query(`UPDATE email_outbox SET created_at = now() - interval '1 hour' WHERE id = ANY($1)`, [
      ids,
    ]);

    // The settle for whichever row the sweep reaches first is refused. The
    // other two are nothing to do with it and must still be delivered: a batch
    // is up to five hundred rows, and abandoning the tail leaves every one of
    // them holding a lease and one attempt poorer for a send nobody tried.
    failFirst('UPDATE email_outbox\n     SET status');
    await retryFailedEmails({ pool, transport });

    expect(sent).toHaveLength(3);
  });
});
