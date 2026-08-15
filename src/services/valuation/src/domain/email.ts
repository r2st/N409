import { z } from 'zod';

/**
 * Length-bounded email validation for the write boundaries.
 *
 * `z.string().email()` checks a shape, not a size, and the shape has no upper
 * bound: `'a'.repeat(100_000) + '@example.com'` satisfies it. Seven schemas
 * spelled the field that way — including `POST /api/v1/auth/register`, which is
 * unauthenticated — so the only ceiling on an address entering this service was
 * Fastify's 1 MB body limit.
 *
 * What the database does with one is the reason this matters. `users.email` is
 * `text`, so the column accepts anything, but `users_email_key` is a b-tree over
 * `lower(email)` and a b-tree index tuple cannot exceed 2704 bytes. An address
 * past that fails the INSERT with `54000 index row size ... exceeds btree
 * version 4 maximum`, which is not a unique violation, is not caught anywhere,
 * and surfaces as a 500 on the public registration form — an input problem
 * answered as a server fault, in a log line carrying the whole address. The
 * same index guards the admin create/patch/invite paths and, through
 * `scim_external_id`'s own unique index, SCIM provisioning.
 *
 * 320 is RFC 5321's ceiling: 64 octets of local part, `@`, 255 of domain. It is
 * what `routes/contact.ts` and `routes/clientIntake.ts` already used, so this is
 * the platform's existing answer applied to the routes that had none — well
 * under the b-tree limit, and above every deliverable address.
 *
 * Trimmed, because it is written to a column that already treats the address as
 * a key. Zod's `.email()` is anchored and `\s` is in none of its classes, so a
 * padded address used to be a 422; normalising instead means `login` and
 * `forgot-password` charge their per-email throttle to one bucket rather than
 * one per spelling of the same address.
 */
export const MAX_EMAIL_LENGTH = 320;

/** `z.string()` for an email column: trimmed, well-formed, and RFC 5321-bounded. */
export const EmailAddress = z.string().trim().email().max(MAX_EMAIL_LENGTH);

/** Whether `value` is an address this platform will store. */
export function isStorableEmail(value: unknown): value is string {
  return EmailAddress.safeParse(value).success;
}
