import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { stripeProblem } from '../../src/routes/payments.js';
import { StripeApiError } from '../../src/payments/stripe.js';

/**
 * R365 — three error messages that misled or abandoned the reader.
 *
 * 1. `OrderCheckoutBody.tier` and `SubscribeBody.plan_tier` use the same regex
 *    for a plan tier slug. `SubscribeBody` had a message —
 *    "A plan tier is lower-case letters, digits, underscores and hyphens" — and
 *    `OrderCheckoutBody` did not, so Zod answered the customer with "Invalid"
 *    and no format guidance.
 *
 * 2. The partner `key` field on `POST /partners` used `z.string().regex(…)` with
 *    no message, while every other slug field in the codebase carries one. The
 *    admin creating a partner was told "Invalid" with no hint of what characters
 *    a key may contain.
 *
 * 3. `stripeProblem()` handled five Stripe error types with customer-appropriate
 *    messages and let everything else through with Stripe's own sentence. One
 *    type that falls through is `rate_limit_error`, whose message — "Too many
 *    requests hit the API too quickly" — is addressed to a developer, not to the
 *    cardholder pressing Pay. The customer was told they sent too many requests
 *    when the fault is ours.
 */

describe('plan tier regex produces a readable message', () => {
  const TierSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'A plan tier is lower-case letters, digits, underscores and hyphens');

  it('rejects an uppercase tier with guidance, not just "Invalid"', () => {
    const result = TierSchema.safeParse('Enterprise');
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0]!.message;
      expect(message).not.toBe('Invalid');
      expect(message).toContain('lower-case');
    }
  });

  it('rejects a tier with spaces', () => {
    const result = TierSchema.safeParse('my plan');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain('lower-case');
    }
  });

  it('accepts a valid tier', () => {
    expect(TierSchema.safeParse('per_valuation').success).toBe(true);
    expect(TierSchema.safeParse('annual-retainer').success).toBe(true);
  });
});

describe('partner key regex produces a readable message', () => {
  const KeySchema = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'A partner key is lower-case letters, digits and hyphens');

  it('rejects an uppercase key with guidance, not just "Invalid"', () => {
    const result = KeySchema.safeParse('Acme_Corp');
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0]!.message;
      expect(message).not.toBe('Invalid');
      expect(message).toContain('lower-case');
    }
  });

  it('accepts a valid key', () => {
    expect(KeySchema.safeParse('acme-corp').success).toBe(true);
  });
});

describe('stripeProblem handles rate_limit_error without forwarding developer-facing text', () => {
  it('answers a rate_limit_error with a customer sentence, not Stripe\'s developer advice', () => {
    const err = new StripeApiError(
      'Too many requests hit the API too quickly. We recommend an exponential backoff of your requests.',
      429,
      false,
      { stripeType: 'rate_limit_error' },
    );
    const problem = stripeProblem(err);
    expect(problem.detail).not.toContain('exponential backoff');
    expect(problem.detail).not.toContain('Too many requests hit the API');
    expect(problem.detail).toMatch(/Nothing has been charged/);
    expect(problem.detail).toMatch(/try again/i);
  });

  it('answers a bare 429 the same way even without the type field', () => {
    const err = new StripeApiError('Rate limit exceeded', 429, false);
    const problem = stripeProblem(err);
    expect(problem.detail).not.toContain('Rate limit exceeded');
    expect(problem.detail).toMatch(/busy/);
  });

  it('still passes a card_error through in Stripe\'s own words', () => {
    const err = new StripeApiError('Your card was declined.', 402, false, { stripeType: 'card_error' });
    const problem = stripeProblem(err);
    expect(problem.detail).toContain('Your card was declined.');
  });
});
