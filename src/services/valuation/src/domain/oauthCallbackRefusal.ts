/**
 * What to tell somebody whose provider redirect landed nowhere (round 239).
 *
 * The three integration callbacks — accounting, HRIS, cap-table sync — are the
 * only routes on this platform a *browser navigates to* and that can answer
 * with a problem body. Every other failure in those handlers redirects back
 * into the app carrying a result code the page turns into a sentence
 * (`?accounting=denied`, `?sync=error`); these two cannot, because the fact
 * they are refusing is the one that says which engagement to go back to.
 *
 * So the reader gets the raw `application/problem+json` rendered by their
 * browser, and what it said was `Invalid or expired state`. Three things wrong
 * with that at once, all of them the point of this round:
 *
 *   * "state" is the OAuth parameter's name, not a fact about their situation.
 *     The person reading it has just pressed Allow on QuickBooks and has no
 *     model in which "state" is a thing that can expire.
 *   * It names no remedy, and this failure has an easy one — start the connect
 *     again — which the reader cannot guess because they are now on an API URL
 *     with no way back into the product.
 *   * It does not say whether anything was connected. It was not: the token
 *     exchange is below this check and never ran. That is the fact somebody
 *     who has just granted a third party access to their accounting ledger
 *     most wants, and it was the one fact withheld.
 *
 * Reachable rather than exotic. The signed state is minted with a 30-minute
 * expiry (`auth/jwt.ts`), and the window it has to survive is a person reading
 * a provider's consent screen — so leaving the tab while deciding, or coming
 * back to it after a meeting, expires it. Re-opening a callback URL from
 * history does the same. Both are ordinary.
 *
 * ## Why the two causes stay merged, and why the wording does not
 *
 * `Missing state` (400) and a state that will not verify (422) keep their
 * separate statuses, because an integration reads those and they mean different
 * things. What they share is the reader: for a person, "the provider sent us
 * back without the marker" and "the marker no longer verifies" are the same
 * situation with the same fix, and splitting the prose would only invite one of
 * the two to be written carelessly. One sentence per surface, both statuses.
 */

/** The integrations that authenticate their callback with a signed state. */
export type IntegrationCallbackKind = 'accounting' | 'hris' | 'capTable';

/** Where in the product the reader restarts, named as they would name it. */
const RESTART_AT: Record<IntegrationCallbackKind, string> = {
  accounting: 'the Documents tab of the valuation you were connecting',
  hris: 'the Grants tab of the valuation you were connecting',
  capTable: 'the Cap table tab of the valuation you were connecting',
};

/**
 * One sentence per surface: what happened, that nothing was connected, and the
 * fix — in that order, because the middle one is what the reader is anxious
 * about and the last one is what they do next.
 */
export function integrationCallbackRefusal(kind: IntegrationCallbackKind): string {
  return (
    'This connection could not be completed, because the request that started it could not be ' +
    'matched to the approval that came back. That usually means more than 30 minutes passed on ' +
    'the provider’s approval screen, or this page was re-opened from browser history. ' +
    'Nothing has been connected and no access was granted. ' +
    `Go back to ${RESTART_AT[kind]} and press Connect again.`
  );
}
