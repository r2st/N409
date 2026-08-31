import { z } from 'zod';

/**
 * A required free-text field that has to actually say something.
 *
 * `z.string().min(2)` counts characters, and two spaces are two of them. Every
 * length bound in the product is a character count, so every "this field is
 * required" written that way is satisfied by whitespace — and the fields that
 * matter most here are the ones a person's name goes in, which are then
 * *printed*:
 *
 *  - `signer_name` / `signature_text` are drawn onto the certification page of
 *    the 409A (domain/reportSignatures.ts), and `hasMainSignature` is the
 *    publish gate. A signature of two spaces passed the gate, published the
 *    engagement, and printed `/s/` with nothing after it beside an empty name
 *    cell, in the one section of the deliverable whose purpose is to say who
 *    stands behind the conclusion.
 *  - a board member's `name` is printed on the board resolution.
 *
 * Trim-checked rather than trimmed, for the reason {@link templateText} gives:
 * storing a rewrite of what somebody typed, under a 200 that says it was saved
 * as sent, is a different lie. The refusal names the field through zod's own
 * path, so the caller is told which one was blank.
 */
export function nonBlankText(min: number, max: number): z.ZodEffects<z.ZodString, string, string> {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((v) => v.trim().length > 0, 'cannot be only whitespace');
}
