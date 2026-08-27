import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createValuation } from '../../src/repos/valuations.js';
import { enqueueEmail, markEmail, type EmailOutboxRow } from '../../src/repos/emailOutbox.js';
import { runRetentionSweep } from '../../src/routes/retention.js';
import { EMAIL_MAX_ATTEMPTS } from '../../src/domain/emailRetry.js';

/**
 * Storage limitation over the one table that is nothing but correspondence.
 *
 * `email_outbox` holds a recipient address, a subject and the full body of
 * every message this platform has ever sent — and for the transactional
 * templates, a link that was a live credential when it was written. It had no
 * disposition at all: the retention policy for it has been settable from the
 * admin console since feature 10 shipped, saving three numbers and a checkbox
 * to a row that `runRetentionSweep` never read. An operator could enable it,
 * watch it save, and the table would keep growing for as long as the database
 * existed.
 *
 * These are the behaviours that make the control real, and the two it must
 * refuse: a legal hold freezes the rows it covers, and a message the retry
 * ladder could still take is never deleted.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'human' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('the email outbox retention policy', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM email_outbox');
    await ctx.pool.query('DELETE FROM retention_actions');
    await ctx.pool.query('UPDATE legal_holds SET active = false');
    // The valuation policy is off for every case here, so an archival never
    // contributes to the counts these assertions read.
    await setPolicy('valuation', { archive_after_days: null, retention_days: null, enabled: false });
  });

  async function setPolicy(
    dataType: string,
    body: { archive_after_days: number | null; retention_days: number | null; enabled: boolean },
  ) {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/retention/policies/${dataType}`,
      headers: authHeader(admin.token),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  }

  /** A sent message, backdated so the policy can reach it. */
  async function agedEmail(
    ageDays: number,
    overrides: Partial<{ toEmail: string; toUserId: string | null; valuationId: string | null }> = {},
  ): Promise<EmailOutboxRow> {
    const row = await enqueueEmail(ctx.pool, {
      toEmail: overrides.toEmail ?? 'client@test.example.com',
      toUserId: overrides.toUserId ?? null,
      valuationId: overrides.valuationId ?? null,
      templateKey: 'test_template',
      subject: 'Your valuation',
      body: 'Body',
    });
    await markEmail(ctx.pool, row.id, 'sent');
    await ctx.pool.query(
      `UPDATE email_outbox SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`,
      [row.id, String(ageDays)],
    );
    return row;
  }

  const survives = async (id: string) =>
    (await ctx.pool.query('SELECT 1 FROM email_outbox WHERE id = $1', [id])).rowCount === 1;

  it('does nothing while the policy is disabled', async () => {
    const old = await agedEmail(900);
    await setPolicy('email_outbox', { archive_after_days: 365, retention_days: 730, enabled: false });

    const result = await runRetentionSweep(ctx.pool);
    expect(result.purged).toBe(0);
    expect(await survives(old.id)).toBe(true);
  });

  it('does nothing while the policy names no retention age', async () => {
    // `retention_days` null has always meant "keep forever" (migration 0083).
    // Enabling a policy with no age must not be read as enabling deletion.
    const old = await agedEmail(900);
    await setPolicy('email_outbox', { archive_after_days: 365, retention_days: null, enabled: true });

    expect((await runRetentionSweep(ctx.pool)).purged).toBe(0);
    expect(await survives(old.id)).toBe(true);
  });

  it('deletes sent mail past the age and leaves younger mail alone', async () => {
    const old = await agedEmail(900);
    const young = await agedEmail(10);
    await setPolicy('email_outbox', { archive_after_days: null, retention_days: 730, enabled: true });

    const result = await runRetentionSweep(ctx.pool);
    expect(result.purged).toBe(1);
    expect(await survives(old.id)).toBe(false);
    expect(await survives(young.id)).toBe(true);
  });

  it('records every deletion in the decision log', async () => {
    // A destructive sweep with no record of the policy that caused it is the
    // gap the action log exists to close.
    const old = await agedEmail(900);
    await setPolicy('email_outbox', { archive_after_days: null, retention_days: 730, enabled: true });
    await runRetentionSweep(ctx.pool);

    const { rows } = await ctx.pool.query<{ action: string; reference_id: string; detail: unknown }>(
      `SELECT action, reference_id, detail FROM retention_actions WHERE data_type = 'email_outbox'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('purged');
    expect(rows[0]!.reference_id).toBe(old.id);
    expect(rows[0]!.detail).toMatchObject({ retention_days: 730 });
  });

  it('takes the delivery ledger with the message', async () => {
    // `email_delivery_events` cascades from the outbox row. Asserted rather
    // than assumed: a bounce ledger left pointing at a deleted message is the
    // orphan half of a purge, and it carries the same recipient.
    const old = await agedEmail(900);
    await ctx.pool.query(
      `INSERT INTO email_delivery_events (id, outbox_id, kind, occurred_at, source)
       VALUES ($1, $2, 'delivered', now(), 'webhook:test')`,
      [newUlid(), old.id],
    );
    await setPolicy('email_outbox', { archive_after_days: null, retention_days: 730, enabled: true });
    await runRetentionSweep(ctx.pool);

    const { rowCount } = await ctx.pool.query('SELECT 1 FROM email_delivery_events WHERE outbox_id = $1', [
      old.id,
    ]);
    expect(rowCount).toBe(0);
  });

  describe('legal holds', () => {
    async function placeHold(scope: 'global' | 'user' | 'valuation', referenceId: string | null) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/retention/holds',
        headers: authHeader(admin.token),
        payload: { scope, reference_id: referenceId, reason: 'IRS audit' },
      });
      expect(res.statusCode).toBe(201);
    }

    it('freezes the recipient named by a user hold', async () => {
      const held = await seedUser(ctx, { roles: [] });
      const heldMail = await agedEmail(900, { toUserId: held.id });
      const otherMail = await agedEmail(900);
      await placeHold('user', held.id);
      await setPolicy('email_outbox', { archive_after_days: null, retention_days: 730, enabled: true });

      const result = await runRetentionSweep(ctx.pool);
      expect(result.purged).toBe(1);
      expect(result.skipped_hold).toBe(1);
      expect(await survives(heldMail.id)).toBe(true);
      expect(await survives(otherMail.id)).toBe(false);
    });

    it('freezes mail about an engagement named by a valuation hold', async () => {
      const v = await createValuation(
        ctx.pool,
        { kind: '409a', companyName: 'HeldCo', userId: admin.id },
        { ...actor, actorId: admin.id },
      );
      const heldMail = await agedEmail(900, { valuationId: v.id });
      await placeHold('valuation', v.id);
      await setPolicy('email_outbox', { archive_after_days: null, retention_days: 730, enabled: true });

      expect((await runRetentionSweep(ctx.pool)).purged).toBe(0);
      expect(await survives(heldMail.id)).toBe(true);
    });

    it('freezes everything under a global hold, including mail with no account behind it', async () => {
      // A client contact mailed an intake link has no `to_user_id`, so no user
      // hold can name them. The global hold is what covers that case, and it
      // is the one an operator reaches for when they do not yet know the scope.
      const anonymous = await agedEmail(900, { toUserId: null });
      await placeHold('global', null);
      await setPolicy('email_outbox', { archive_after_days: null, retention_days: 730, enabled: true });

      const result = await runRetentionSweep(ctx.pool);
      expect(result.purged).toBe(0);
      expect(result.skipped_hold).toBe(1);
      expect(await survives(anonymous.id)).toBe(true);
    });
  });

  describe('mail the retry ladder has not finished with', () => {
    it('never deletes a queued message, however old', async () => {
      // A stranded 'queued' row is what a process killed between the INSERT
      // and the transport call leaves behind; `claimRetryableEmails` picks it
      // up. Ageing it out is losing mail, not ageing it out.
      const stranded = await enqueueEmail(ctx.pool, {
        toEmail: 'client@test.example.com',
        templateKey: 'test_template',
        subject: 'Queued',
        body: 'Body',
      });
      await ctx.pool.query(
        `UPDATE email_outbox SET created_at = now() - interval '900 days' WHERE id = $1`,
        [stranded.id],
      );
      await setPolicy('email_outbox', { archive_after_days: null, retention_days: 730, enabled: true });

      expect((await runRetentionSweep(ctx.pool)).purged).toBe(0);
      expect(await survives(stranded.id)).toBe(true);
    });

    it('never deletes a failed message with attempts left', async () => {
      const retryable = await enqueueEmail(ctx.pool, {
        toEmail: 'client@test.example.com',
        templateKey: 'test_template',
        subject: 'Failed',
        body: 'Body',
      });
      await markEmail(ctx.pool, retryable.id, 'failed', 'smtp connect refused');
      await ctx.pool.query(
        `UPDATE email_outbox SET created_at = now() - interval '900 days', attempts = 1 WHERE id = $1`,
        [retryable.id],
      );
      await setPolicy('email_outbox', { archive_after_days: null, retention_days: 730, enabled: true });

      expect((await runRetentionSweep(ctx.pool)).purged).toBe(0);
      expect(await survives(retryable.id)).toBe(true);
    });

    it('deletes a failed message the ladder has given up on', async () => {
      const exhausted = await enqueueEmail(ctx.pool, {
        toEmail: 'client@test.example.com',
        templateKey: 'test_template',
        subject: 'Failed',
        body: 'Body',
      });
      await markEmail(ctx.pool, exhausted.id, 'failed', 'smtp connect refused');
      await ctx.pool.query(
        `UPDATE email_outbox SET created_at = now() - interval '900 days', attempts = $2 WHERE id = $1`,
        [exhausted.id, EMAIL_MAX_ATTEMPTS],
      );
      await setPolicy('email_outbox', { archive_after_days: null, retention_days: 730, enabled: true });

      expect((await runRetentionSweep(ctx.pool)).purged).toBe(1);
      expect(await survives(exhausted.id)).toBe(false);
    });
  });

  it('tells the console which policies are enforced and which are settings nothing reads', async () => {
    // The console rendered all five data types identically — three numbers and
    // a checkbox — while four of them were read by nothing. `enforcement` is
    // what lets the screen tell them apart.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/retention/policies',
      headers: authHeader(admin.token),
    });
    expect(res.statusCode).toBe(200);
    const byType = new Map<string, { archives: boolean; purges: boolean; note: string }>(
      res
        .json()
        .policies.map((p: { data_type: string; enforcement: { archives: boolean; purges: boolean; note: string } }) => [
          p.data_type,
          p.enforcement,
        ]),
    );
    expect(byType.get('email_outbox')).toMatchObject({ purges: true });
    expect(byType.get('valuation')).toMatchObject({ archives: true });
    for (const inert of ['document', 'calculation', 'audit_event']) {
      expect(byType.get(inert), inert).toMatchObject({ archives: false, purges: false });
      expect(byType.get(inert)!.note.length, `${inert} says why`).toBeGreaterThan(50);
    }
  });
});
