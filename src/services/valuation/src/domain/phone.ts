import { z } from 'zod';
import { e164Error, normalizeE164 } from '@n409/shared';

/**
 * Phone numbers on the way into the database.
 *
 * `users.phone` and `contact_submissions.phone` were validated by length only,
 * so a row could hold `(555) 123-4567` — no country, undialable from anywhere —
 * and nothing noticed until an SMS campaign tried to send to it. These schemas
 * are forgiving about how a person types a number and strict about what is
 * stored: every accepted value comes back as canonical E.164 (`+15551234567`),
 * which is what the outbox hands to a gateway.
 *
 * Legacy rows are not migrated: they are normalized the next time the row is
 * written, and read back as-is until then.
 */

/** Trimmed, normalized, and rejected with the reason when it is not a number. */
const E164String = z
  .string()
  .trim()
  .max(50)
  .transform((value, ctx) => {
    const normalized = normalizeE164(value);
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: e164Error(value) ?? 'Not a valid phone number',
      });
      return z.NEVER;
    }
    return normalized;
  });

/**
 * A phone field that can be cleared: blank and null both store NULL. Use on
 * PATCH bodies, where "" is how a form says "I emptied this box".
 */
export const NullablePhone = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.union([z.null(), E164String]),
);

/**
 * A phone field that may simply be absent. Blank, null and missing all collapse
 * to undefined, so a create body can pass it straight through.
 */
export const OptionalPhone = z.preprocess(
  (v) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v),
  E164String.optional(),
);
