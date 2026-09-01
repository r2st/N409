import { describe, expect, it } from 'vitest';
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_RETRY_BACKOFF_MINUTES,
  newWebhookSecret,
} from '../../src/domain/partnerWebhooks.js';
import { PARTNER_API_PREFIX } from '../../src/routes/partnerApi.js';

/**
 * What the public developer page promises.
 *
 * `/developers` (web-frontend, `pages/marketing/DevelopersPage.tsx`) renders
 * its endpoint table live from `GET /api/partner/v1/docs`, so that half cannot
 * drift. The surrounding facts — the URL prefix, the header names, the secret
 * prefix, the retry ladder — are static there, because a crawler and a
 * first-time reader both need them without running JavaScript. Static means a
 * second copy, and this is the copy that can silently stop being true.
 *
 * These are not assertions about good values; they are assertions that the
 * values a published page tells partners to code against are still the ones
 * this service uses. Change one deliberately and update
 * `web-frontend/src/lib/marketing.ts` (`PARTNER_API`, `WEBHOOK_EVENTS`) in the
 * same commit — that is the whole point of the failure.
 */

/** Kept in the shape the marketing module publishes, for a literal comparison. */
const PUBLISHED = {
  prefix: '/api/partner/v1',
  webhookSecretPrefix: 'n409_whsec_',
  signatureHeader: 'x-n409-signature',
  eventHeader: 'x-n409-event',
  deliveryHeader: 'x-n409-delivery',
  retryLadderMinutes: [1, 5, 30, 120, 360],
  events: [
    'valuation.state_changed',
    'valuation.report_ready',
    'valuation.retired',
    'valuation.restored',
    'webhook.test',
  ],
};

describe('the public /developers page still describes this API', () => {
  it('publishes the base path partners send requests to', () => {
    expect(PARTNER_API_PREFIX).toBe(PUBLISHED.prefix);
  });

  it('publishes the headers a receiver reads off a delivery', () => {
    expect(SIGNATURE_HEADER).toBe(PUBLISHED.signatureHeader);
    expect(EVENT_HEADER).toBe(PUBLISHED.eventHeader);
    expect(DELIVERY_HEADER).toBe(PUBLISHED.deliveryHeader);
  });

  it('publishes the prefix of the secret returned at registration', () => {
    expect(newWebhookSecret().startsWith(PUBLISHED.webhookSecretPrefix)).toBe(true);
  });

  it('publishes the full event vocabulary', () => {
    // A partner subscribing to an event we no longer send, or missing one we
    // now do, finds out from their own logs otherwise.
    expect([...WEBHOOK_EVENT_TYPES]).toEqual(PUBLISHED.events);
  });

  it('publishes the retry ladder, in order', () => {
    // The page states each step and derives "N attempts in total" from the
    // length, so both the values and the count are load-bearing.
    expect([...WEBHOOK_RETRY_BACKOFF_MINUTES]).toEqual(PUBLISHED.retryLadderMinutes);
  });
});
