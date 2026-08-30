import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SERVED_SUBSCRIPTION_STATUSES,
  STRIPE_STATUS_MAP,
  STRIPE_SUBSCRIPTION_STATUSES,
  localSubscriptionStatus,
} from '../../src/domain/billing.js';

/**
 * Every status Stripe can report has a reading here, and it is a stated one.
 *
 * The mapping was an if-chain ending in `return 'past_due'`, with a comment
 * naming three of the statuses that fell into it. Stripe has eight. `unpaid` —
 * where dunning ends on an account configured to keep the subscription — and
 * `paused` — collection paused, or a trial ended with no card, where nothing is
 * owed and nothing is being retried — both landed there unmentioned, and
 * `past_due` is a *served* status. So an account in either kept the plan's full
 * quota with nothing arriving, and the subscriber was told their last payment
 * did not go through.
 *
 * These pin the reading rather than change it: bounding the grace period is a
 * revenue decision, and the point of the table is that the next status Stripe
 * adds is a decision somebody takes instead of a default they inherit.
 */
describe('the Stripe subscription status map', () => {
  it('gives every declared Stripe status a local reading', () => {
    expect(Object.keys(STRIPE_STATUS_MAP).sort()).toEqual([...STRIPE_SUBSCRIPTION_STATUSES].sort());
  });

  it('holds the two dunning-adjacent statuses as served, and says so', () => {
    // The finding, stated as an assertion so a change to it is deliberate.
    for (const status of ['unpaid', 'paused'] as const) {
      expect([status, STRIPE_STATUS_MAP[status]]).toEqual([status, 'past_due']);
      expect([status, SERVED_SUBSCRIPTION_STATUSES].flat()).toContain('past_due');
    }
  });

  it('does not end a subscription Stripe has not ended', () => {
    const canceled = STRIPE_SUBSCRIPTION_STATUSES.filter((s) => STRIPE_STATUS_MAP[s] === 'canceled');
    expect([...canceled]).toEqual(['incomplete_expired', 'canceled']);
  });

  it('reports a status it has never seen instead of absorbing it', () => {
    expect(localSubscriptionStatus('active')).toEqual({ status: 'active', known: true });
    // Conservative — neither hands over a plan nor ends a live subscription —
    // and flagged, which is what the fallthrough could not be.
    expect(localSubscriptionStatus('quantum_superposition')).toEqual({
      status: 'past_due',
      known: false,
    });
  });

  it('is the only place the billing route decides a status', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../../src/routes/billing.ts', import.meta.url)),
      'utf8',
    );
    // A second `status === '…'` chain in the route is how the table stops being
    // the answer. The webhook is allowed exactly one call into the map.
    expect(source.match(/localSubscriptionStatus\(/g)).toHaveLength(1);
  });
});
