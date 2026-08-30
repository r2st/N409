/**
 * What to tell the holder of a public link that will not open (round 222).
 *
 * Six surfaces hand a secret token to somebody outside the product — the
 * client intake questionnaire, the auditor portal, the board signing page, and
 * (added in round 239) the password reset, the email verification and the
 * invitation. All of them answered every way a link can be dead with one
 * sentence that listed the possible causes and stopped:
 *
 *   "This intake link is invalid, expired, or withdrawn"
 *   "This auditor link is invalid, expired, or revoked"
 *   "This reset link is invalid, expired, or already used"
 *   "This invitation is invalid, expired, or has been revoked"
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

import { VERIFICATION_TOKEN_TTL } from '../repos/emailVerifications.js';
import { INVITE_TTL } from '../repos/invitations.js';
import { RESET_TOKEN_TTL } from '../repos/passwordResets.js';

/**
 * The public surfaces that authenticate a reader by a link alone.
 *
 * The last three were missed by round 222 and are the highest-volume of the
 * six: every new account passes through a verification link, and a password
 * reset is the one link somebody follows while already locked out. All three
 * carried the sentence this file was written to replace, verbatim in the shape
 * quoted above — a list of causes, no remedy, and no answer to the question
 * the reader is actually asking, which for a reset is whether their password
 * has changed and for an invitation is whether an account now exists.
 */
export type PublicLinkKind = 'intake' | 'auditor' | 'board' | 'reset' | 'verification' | 'invitation';

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
 * is the whole reason these are six strings and not one — as does the fact the
 * reader is anxious about, which each sentence ends on.
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
  /*
   * The three account links. Each ends on the fact its reader is anxious
   * about, and each of those is a different fact — which is the reason these
   * are three strings rather than one with the noun swapped.
   *
   * The expiries are interpolated from the constants the rows are written
   * with, not copied into the prose, because a message that states a deadline
   * is a message that can quietly start lying when somebody changes the
   * interval. `RESET_TOKEN_TTL` and friends are Postgres intervals and read as
   * English by construction — '1 hour', '24 hours', '7 days'.
   */
  reset:
    'This password-reset link is no longer usable. It may have been cut short when it was ' +
    'copied — open the original email and use the whole link, including any part that wrapped ' +
    `onto a second line — or it may have been used already, or expired: reset links last ${RESET_TOKEN_TTL} ` +
    'and work once. Your password has not been changed and your account is untouched. ' +
    'Ask for a new link from the “Forgot password” page and use the newest email, not an older one.',
  verification:
    'This email-verification link is no longer usable. It may have been cut short when it was ' +
    'copied — open the original email and use the whole link, including any part that wrapped ' +
    `onto a second line — or it may have expired: verification links last ${VERIFICATION_TOKEN_TTL}. ` +
    'Your account still exists and your password still works. Sign in and we will send a fresh ' +
    'verification email.',
  invitation:
    'This invitation link is no longer usable. It may have been cut short when it was copied — ' +
    'open the original email and use the whole link, including any part that wrapped onto a ' +
    `second line — or it may have been accepted already, expired (invitations last ${INVITE_TTL}), ` +
    'or been withdrawn. No account has been created for you. ' +
    'Ask the person who invited you to send a fresh invitation.',
};
