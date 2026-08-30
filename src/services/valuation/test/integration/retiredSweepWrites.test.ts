import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { retireValuations, restoreValuations } from '../../src/repos/valuationPurge.js';
import { upsertConnection as upsertCapTableConnection } from '../../src/repos/capTableConnections.js';
import { upsertConnection as upsertHrisConnection } from '../../src/repos/hrisConnections.js';
import { findDueConnections as findDueCapTableConnections } from '../../src/repos/capTableConnections.js';
import { findDueConnections as findDueHrisConnections } from '../../src/repos/hrisConnections.js';
import { claimRetryableEmails, enqueueEmail } from '../../src/repos/emailOutbox.js';
import { createPipelineRun, latestPipelineRun, setPipelineRunStatus } from '../../src/repos/pipelineRuns.js';
import { retryFailedPipelineRuns } from '../../src/hooks/pipelineRetry.js';
import type { AutoPipelineDeps } from '../../src/pipeline/autoPipeline.js';

const dbUp = await isDbAvailable();
const SYSTEM = { actorType: 'system', actorId: 'test', source: 'auto-pipeline' } as const;

/**
 * A guard on a route is not a guard on the timer that performs the same write.
 *
 * R89 asked every mutating valuation-scoped *route* whether the engagement had
 * been retired and found ten that did not, and the sweep it wrote to find them
 * drives routes. This service also runs eleven scheduled sweeps, and four of
 * them write to a valuation without going through a route at all — so a firm
 * could withdraw an engagement, watch every button in the product stop
 * accepting changes, and have a timer go on working the file:
 *
 *   * the auto-pipeline retry ladder resumed a run that had failed before the
 *     withdrawal, auto-applying an AI extraction and recording a calculation;
 *   * the cap-table sync pulled the client's cap table from Carta and applied
 *     it — and called Carta at all, which is telling a third party we are
 *     still working a file the firm has withdrawn;
 *   * the HRIS sync imported option grants;
 *   * the email ladder delivered a reminder queued the day before, which is
 *     the worst of the four, because mail cannot be un-sent. That is the same
 *     message R89 stopped `POST /remind-documents` from sending, arriving by
 *     the other door.
 *
 * Each case below drives the sweep's own entry point against a retired
 * engagement and a live twin, because "did nothing" is what a broken sweep
 * looks like too.
 */
describe.skipIf(!dbUp)('the scheduled sweeps and a retired engagement', () => {
  /** Attribution for the connect/disconnect events both writes record (R256). */
  const evActor = () => ({ actorType: 'human' as const, actorId: ops.id, source: 'test' });

  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  async function newValuation(company: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: company },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  const tokens = { accessToken: 'tok', refreshToken: null, expiresAt: null };

  const due = async (valuationId: string, table: 'cap_table_connections' | 'hris_connections') => {
    await ctx.pool.query(
      `UPDATE ${table} SET sync_frequency = 'daily', next_sync_at = now() - interval '1 hour'
        WHERE valuation_id = $1`,
      [valuationId],
    );
  };

  describe('the cap-table sync', () => {
    it('skips a withdrawn engagement and keeps working a live one', async () => {
      const live = await newValuation('SweepGuard CapTable Live');
      const dead = await newValuation('SweepGuard CapTable Dead');
      for (const id of [live, dead]) {
        await upsertCapTableConnection(
          ctx.pool,
          {
            valuationId: id,
            provider: 'carta',
            tokens,
            connectedBy: ops.id,
          },
          evActor(),
        );
        await due(id, 'cap_table_connections');
      }

      const before = (await findDueCapTableConnections(ctx.pool, 100)).map((c) => c.valuation_id);
      expect(before).toContain(live);
      expect(before).toContain(dead);

      await retireValuations(ctx.pool, [dead]);

      const after = (await findDueCapTableConnections(ctx.pool, 100)).map((c) => c.valuation_id);
      // The live twin is the vacuity guard: a query that had simply stopped
      // returning anything would satisfy the assertion below on its own.
      expect(after).toContain(live);
      expect(after).not.toContain(dead);
    });

    it('picks the connection back up when the engagement is restored', async () => {
      // Skipped rather than disabled, because a retirement is reversible. If
      // the sweep had settled the connection instead, a restore would give
      // back an engagement whose integration had quietly been turned off.
      const id = await newValuation('SweepGuard CapTable Restored');
      await upsertCapTableConnection(
        ctx.pool,
        {
          valuationId: id,
          provider: 'pulley',
          tokens,
          connectedBy: ops.id,
        },
        evActor(),
      );
      await due(id, 'cap_table_connections');

      await retireValuations(ctx.pool, [id]);
      expect((await findDueCapTableConnections(ctx.pool, 100)).map((c) => c.valuation_id)).not.toContain(id);

      await restoreValuations(ctx.pool, [id]);
      expect((await findDueCapTableConnections(ctx.pool, 100)).map((c) => c.valuation_id)).toContain(id);
    });
  });

  describe('the HRIS sync', () => {
    it('skips a withdrawn engagement and keeps working a live one', async () => {
      const live = await newValuation('SweepGuard Hris Live');
      const dead = await newValuation('SweepGuard Hris Dead');
      for (const id of [live, dead]) {
        await upsertHrisConnection(
          ctx.pool,
          {
            valuationId: id,
            provider: 'gusto',
            tokens,
            connectedBy: ops.id,
          },
          evActor(),
        );
        await due(id, 'hris_connections');
      }
      await retireValuations(ctx.pool, [dead]);

      const after = (await findDueHrisConnections(ctx.pool, 100)).map((c) => c.valuation_id);
      expect(after).toContain(live);
      expect(after).not.toContain(dead);
    });
  });

  describe('the email retry ladder', () => {
    const queueFor = async (valuationId: string | null, subject: string) => {
      const row = await enqueueEmail(ctx.pool, {
        valuationId,
        toUserId: ops.id,
        toEmail: ops.email ?? 'sweepguard@n409.example',
        channel: 'email',
        templateKey: 'documents_reminder',
        subject,
        body: 'We still need your cap table.',
        promotional: false,
      });
      // Failed, so it is claimable by the ladder rather than by the first send.
      await ctx.pool.query(
        `UPDATE email_outbox SET status = 'failed', error = 'relay timeout', next_attempt_at = now() - interval '1 minute'
          WHERE id = $1`,
        [row.id],
      );
      return row.id;
    };

    const claim = () => claimRetryableEmails(ctx.pool, { channels: ['email'], maxAttempts: 5, limit: 200 });

    it('does not deliver a reminder about work that has been withdrawn', async () => {
      const live = await newValuation('SweepGuard Mail Live');
      const dead = await newValuation('SweepGuard Mail Dead');
      const liveMail = await queueFor(live, 'live reminder');
      const deadMail = await queueFor(dead, 'withdrawn reminder');
      await retireValuations(ctx.pool, [dead]);

      const claimed = (await claim()).map((r) => r.id);
      // Mail cannot be un-sent, which is what makes this the worst of the four.
      expect(claimed).not.toContain(deadMail);
      expect(claimed).toContain(liveMail);
    });

    it('leaves a message that is about a person rather than a piece of work', async () => {
      // A password reset carries no valuation, and must not be caught by a
      // filter aimed at engagements.
      const id = await queueFor(null, 'password reset');
      expect((await claim()).map((r) => r.id)).toContain(id);
    });

    it('stops claiming rather than failing, so a restore un-blocks the queue', async () => {
      const id = await newValuation('SweepGuard Mail Restored');
      const mail = await queueFor(id, 'restorable reminder');
      await retireValuations(ctx.pool, [id]);
      expect((await claim()).map((r) => r.id)).not.toContain(mail);

      // Still 'failed' with attempts intact — nothing settled it, so it is
      // claimable the moment the engagement comes back. A row marked
      // permanently failed could not be un-failed by a restore.
      const { rows } = await ctx.pool.query<{ status: string }>(
        'SELECT status FROM email_outbox WHERE id = $1',
        [mail],
      );
      expect(rows[0]!.status).toBe('failed');

      await restoreValuations(ctx.pool, [id]);
      expect((await claim()).map((r) => r.id)).toContain(mail);
    });
  });

  describe('the auto-pipeline retry ladder', () => {
    const log = () =>
      ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }) as unknown as AutoPipelineDeps['log'];

    it('settles a claimed run instead of resuming it on a withdrawn engagement', async () => {
      const id = await newValuation('SweepGuard Pipeline Dead');
      const run = await createPipelineRun(
        ctx.pool,
        { valuationId: id, trigger: 'upload', triggeredBy: ops.id },
        SYSTEM,
      );
      await setPipelineRunStatus(ctx.pool, run, 'failed', {
        error: 'ai service unavailable',
        actor: SYSTEM,
        failure: { kind: 'transient', reason: 'ai.unavailable', retryable: true },
      });
      await ctx.pool.query(
        `UPDATE pipeline_runs SET status = 'failed', next_attempt_at = now() - interval '1 minute' WHERE id = $1`,
        [run.id],
      );
      await retireValuations(ctx.pool, [id]);

      const logger = log();
      await retryFailedPipelineRuns({
        pool: ctx.pool,
        autoPipeline: {
          pool: ctx.pool,
          aiUrl: 'http://127.0.0.1:1',
          engineUrl: 'http://127.0.0.1:1',
          documentsDir: './data/documents',
          enabled: false,
          log: logger,
        },
        limit: 50,
      });

      const after = await latestPipelineRun(ctx.pool, id);
      expect(after?.status).toBe('failed');
      expect(after?.error).toMatch(/retired/i);
      // Settled rather than abandoned: the claim already moved it to an active
      // status, and an active run holds the one-per-valuation index — so
      // walking away would block the engagement even after a restore.
      expect(after?.next_attempt_at).toBeNull();
    });
  });
});
