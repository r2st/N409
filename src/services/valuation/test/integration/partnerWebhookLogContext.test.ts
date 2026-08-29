/**
 * A failed first attempt says which delivery it was.
 *
 * Every line the retry sweep writes carries `deliveryId` — the abandoned one,
 * the superseded one, the exhausted one. The *first* attempt's failure line did
 * not: it named the webhook and the event, so attempt 1 of a ladder was
 * recorded in a different vocabulary from attempts 2 through 5, and a delivery
 * that failed once and then succeeded had its only failure unreachable from the
 * row describing it. That row id is also what the partner's own delivery log
 * shows them, so it is the id a complaint arrives quoting.
 *
 * Driven through `deliverToWebhook` with a resolver that answers the way a
 * private target does, because that is a failure reachable without a receiver
 * and it takes the same path out as a refused connection.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newWebhookSecret, setWebhookTargetPolicy } from '../../src/domain/partnerWebhooks.js';
import { deliverToWebhook } from '../../src/hooks/partnerWebhooks.js';
import { createWebhook, listDeliveries } from '../../src/repos/partnerWebhooks.js';
import { createValuation } from '../../src/repos/valuations.js';
import { isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('the partner webhook delivery failure line', () => {
  let ctx: TestApp;
  let partnerId: string;
  let ownerId: string;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    setWebhookTargetPolicy(false);
    partnerId = await seedPartner(ctx, 'Log Context Partners');
    ownerId = (await seedUser(ctx, { roles: ['partner'], partnerId })).id;
    valuationId = (
      await createValuation(
        ctx.pool,
        { kind: '409a', companyName: 'Log Context Co.', userId: ownerId },
        { actorType: 'human', actorId: ownerId },
      )
    ).id;
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  it('names the delivery row and the engagement, not just the webhook', async () => {
    const webhook = await createWebhook(ctx.pool, {
      partnerId,
      url: 'http://private.example.com/hook',
      secret: newWebhookSecret(),
      events: [],
      createdBy: ownerId,
    });
    const warnings: Array<Record<string, unknown>> = [];
    const log = {
      warn: (obj: Record<string, unknown>) => warnings.push(obj),
      error: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as Parameters<typeof deliverToWebhook>[0]['log'];

    const outcome = await deliverToWebhook(
      { pool: ctx.pool, lookupFn: async () => [{ address: '127.0.0.1' }], log },
      webhook,
      'webhook.test',
      { event: 'webhook.test' },
      valuationId,
    );
    expect(outcome).toBe('failed');

    const { items } = await listDeliveries(ctx.pool, webhook.id);
    expect(items).toHaveLength(1);
    const failure = warnings.find((w) => w.webhookId === webhook.id);
    expect(failure, 'the failure was not logged at all').toBeDefined();
    // The row the partner sees, and the engagement the event was about.
    expect(failure!.deliveryId).toBe(items[0]!.id);
    expect(failure!.valuationId).toBe(valuationId);
  });
});
