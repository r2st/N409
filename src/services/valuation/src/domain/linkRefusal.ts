/**
 * What to tell the holder of a public link that will not open (round 222).
 *
 * Three surfaces hand a secret token to somebody outside the product — the
 * client intake questionnaire, the auditor portal, the board signing page —
 * and all three answered every way a link can be dead with one sentence that
 * listed the possible causes and stopped:
 *
 *   "This intake link is invalid, expired, or withdrawn"
 *   "This auditor link is invalid, expired, or revoked"
 *
 * The reader of those sentences is the one person on the platform with no
 * account, no support console and nobody obvious to ask. They cannot look up
 * which of the three it was, and the message does not say who could. So the
 * two things a refusal owes them — why, and what to do now — are exactly the
 * two it withholds, and the observable result is the client emailing the firm
 * to ask what happened, which is the work the sentence existed to save.
 *
 * ## Why the causes stay merged
 *
 * It is tempting to tell them apart: the row knows. `client_intake_links` has
 * `revoked_at`, `expires_at` and an archived-partner test, and the failing
 * predicate is right there in the WHERE clause. `clientIntake.ts` says why not,
 * and it is a real reason rather than an oversight:
 *
 *   "this is an unauthenticated endpoint, and distinguishing them tells a
 *    guesser which of their guesses was a real token."
 *
 * A message that separates "expired" from "unrecognised" is an oracle for
 * whether a token exists, because only a token that exists can be expired. That
 * decision is left standing here.
 *
 * What does not follow from it is the *quality* of the merged answer. One
 * sentence covering four conditions can still name the cause the reader is
 * most likely to be able to fix, and can still say who to go to for the ones
 * they cannot. Nothing below distinguishes anything — every dead state on a
 * surface gets the identical string — so the oracle is exactly as shut as it
 * was, and the reader is no longer told to work it out themselves.
 *
 * ## The cause that is worth naming first
 *
 * "Invalid" was doing the most damage as the *first* word, because the reading
 * it invites — that the link is fake — is the one a client cannot act on. The
 * likeliest cause of an unrecognised token is not a forgery, it is a link that
 * did not survive being copied: these tokens are 43 characters of base64url on
 * the end of a URL, and mail clients wrap them, chat clients truncate them, and
 * a reader who selects a link by dragging usually misses the last character.
 * That failure looks identical to a revoked link and is fixed in five seconds
 * by opening the mail again, so it goes first.
 */

/** The public surfaces that authenticate a reader by a link alone. */
export type PublicLinkKind = 'intake' | 'auditor' | 'board';

/**
 * One sentence per surface, covering every way that surface's link can be dead.
 *
 * Deliberately *not* keyed on the reason. The type is the surface only, so
 * there is no shape in which a caller can pass the failing predicate through to
 * the reader even by accident.
 *
 * Each names the same three things: that the link is not usable, the two causes
 * the reader can do something about (a link cut short in transit, a deadline
 * that has passed), and who reissues it. Who that is differs per surface, which
 * is the whole reason these are three strings and not one.
 */
export const DEAD_LINK_DETAIL: Record<PublicLinkKind, string> = {
  intake:
    'This questionnaire link is no longer usable. It may have been cut short when it was ' +
    'copied — open the original email and use the whole link, including any part that wrapped ' +
    'onto a second line — or it may have passed its deadline or been withdrawn. ' +
    'Reply to the firm that sent it to have a new one issued; anything you had already saved is kept.',
  auditor:
    'This auditor link is no longer usable. It may have been cut short when it was copied — ' +
    'open the original email and use the whole link, including any part that wrapped onto a ' +
    'second line — or it may have passed its expiry date or been revoked. ' +
    'Ask the valuation team who sent it to issue a fresh link.',
  board:
    'This signing link is no longer usable. It may have been cut short when it was copied — ' +
    'open the original email and use the whole link, including any part that wrapped onto a ' +
    'second line — or it may have passed its deadline. ' +
    'Ask whoever circulated the resolution to send you a new signing link; no decision has been recorded for you.',
};
