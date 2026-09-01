import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createWebhook, enabledWebhooks } from '../../src/repos/partnerWebhooks.js';
import { firePartnerWebhooks } from '../../src/hooks/partnerWebhooks.js';
import { isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The partner fan-out after the firm behind it is archived.
 *
 * `enabledWebhooks` tested `enabled` — the firm's own switch — and never
 * whether the firm was still on this platform. `partners.archived_at` is the
 * platform's soft delete for a firm: it takes the firm's user assignments, its
 * branding edits and its outstanding client intake links away, each closed as
 * somebody noticed that door. This is the door that runs by itself. Three
 * single-row callers ride every transition of a partner engagement and the
 * retention sweep fans out over a batch of them, so a withdrawn firm went on
 * being POSTed its old clients' engagement numbers, company names and states
 * for as long as those engagements moved — and could not stop it, because the
 * console it would delete the hook from is behind a partner API key, and an
 * archived firm's key is refused.
 *
 * Asserted at `enabledWebhooks` because that is where the rule lives: all four
 * fan-out call sites read through it, which is the same reason `LIVE_LINK_SQL`
 * holds the intake links' copy of this predicate in one fragment. The dispatch
 * assertion below is the other half — no delivery row is written at all, so
 * nothing is left pending for a receiver that should not be hearing from us.
 */
describe.skipIf(!dbUp)('partner webhooks when the firm has been archived', () => {
  let ctx: TestApp;
  let firmId: string;
  let hookId: string;

  const deliveryCount = async (): Promise<number> => {
    const { rows } = await ctx.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM partner_webhook_deliveries WHERE webhook_id = $1',
      [hookId],
    );
    return Number(rows[0]?.n ?? 0);
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    firmId = await seedPartner(ctx, `Withdrawn Advisors ${Date.now()}`);
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    const hook = await createWebhook(ctx.pool, {
      partnerId: firmId,
      url: 'https://receiver.example.com/n409',
      secret: 'whsec_testing_only',
      events: ['valuation.state_changed'],
      createdBy: admin.id,
    });
    hookId = hook.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('fans out to a live firm', async () => {
    // Without this the assertions below pass for a fixture that never had a
    // hook to find — the shape a census in this repo has been caught by before.
    expect((await enabledWebhooks(ctx.pool, firmId)).map((h) => h.id)).toEqual([hookId]);
  });

  it('finds nothing to fan out to once the firm is archived', async () => {
    await ctx.pool.query('UPDATE partners SET archived_at = now() WHERE id = $1', [firmId]);
    expect(await enabledWebhooks(ctx.pool, firmId)).toEqual([]);
  });

  it('queues no delivery for a withdrawn firm', async () => {
    // A delivery row is written before the attempt, so "no row" is the whole
    // claim: nothing was POSTed and nothing is sitting pending for a retry.
    expect(await deliveryCount()).toBe(0);
    await firePartnerWebhooks({ pool: ctx.pool }, firmId, 'valuation.state_changed', null);
    expect(await deliveryCount()).toBe(0);
  });

  it('is a refusal and not a revocation — un-archiving brings the hook back', async () => {
    // The same property `partner_retired` claims for the firm's API key, and
    // the reason both rules are allowed to be this blunt: archiving is one
    // boolean an administrator can set back.
    await ctx.pool.query('UPDATE partners SET archived_at = NULL WHERE id = $1', [firmId]);
    expect((await enabledWebhooks(ctx.pool, firmId)).map((h) => h.id)).toEqual([hookId]);
  });

  it('leaves the hook itself alone, so the console can still show it', async () => {
    // Archiving hides the firm; it does not delete what the firm configured.
    const { rows } = await ctx.pool.query<{ enabled: boolean }>(
      'SELECT enabled FROM partner_webhooks WHERE id = $1',
      [hookId],
    );
    expect(rows[0]?.enabled).toBe(true);
  });
});
