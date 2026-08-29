import { z } from 'zod';

/**
 * A template field that has to say something.
 *
 * `z.string().min(1)` counts characters, and a subject of three spaces has
 * three of them. Every save path for template copy used that bound and every
 * *render* path then asked a different question — `applyTemplateOverrides`,
 * `applyPartnerEmailTemplates` and `sendTransactionalEmail` all gate on
 * `override.subject && override.body`, which a whitespace string passes. So a
 * template saved with a subject or a body of spaces was accepted, reported
 * saved, listed as enabled, and silently replaced the platform's copy with
 * nothing: the client received an email with a blank subject line and an empty
 * body, and the outbox row recorded exactly that as delivered.
 *
 * Not a render-time guard, because by render time the honest options are both
 * bad — send the blank, or drop an override an operator can see enabled on
 * their screen. The place to answer it is the save, where there is somebody to
 * tell.
 *
 * Trim-checked rather than trimmed: leading whitespace in a body is sometimes
 * deliberate formatting, and rewriting what an operator typed and storing the
 * rewrite under a 200 that says it was saved as sent is the behaviour
 * `nulBytes` declines for the same reason.
 */
export function templateText(max: number): z.ZodEffects<z.ZodString, string, string> {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0, 'cannot be only whitespace');
}
