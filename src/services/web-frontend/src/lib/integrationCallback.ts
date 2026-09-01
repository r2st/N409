/**
 * What the browser is told when it comes back from a provider's consent screen.
 *
 * The three integration callbacks on the valuation service — accounting,
 * cap-table sync, HRIS — are the only routes a *browser navigates to*, so they
 * cannot answer with a problem body: they redirect back into the app carrying a
 * result code, `?accounting=connected`, `?sync=denied`, `?hris=error`.
 * `domain/oauthCallbackRefusal.ts` on the server says that in as many words —
 * "a result code the page turns into a sentence" — and it was true of exactly
 * one of the three pages.
 *
 * `AccountingConnect` read its parameter. `CapTableSyncPanel` and
 * `HrisSyncPanel` did not read theirs at all, which is the quiet half of this:
 * an analyst who pressed Cancel on Carta's consent screen, or whose token
 * exchange failed, was bounced back to the Cap table tab where the panel
 * refetched, found no connection, and drew the same "Connect" button it drew
 * before — with the answer to "what just happened?" sitting unread in the
 * address bar. The one outcome that needs no sentence, `connected`, is the one
 * the refetch already shows.
 *
 * So one reader, here, for all three. The vocabulary is the server's and there
 * is now a fourth code in it (`retired`), which is precisely the kind of
 * addition that reaches one of three hand-written copies.
 *
 * ## Why the provider name is not echoed
 *
 * `?provider=` rides in on a URL anyone can compose and send to a signed-in
 * analyst, and the sentence it lands in is this workspace's own voice on the
 * tab that holds the client's cap table. React escapes the markup; it cannot
 * escape the claim. Same rule as `SSO_ERROR_MESSAGES` in `pages/LoginPage.tsx`:
 * a fixed vocabulary per surface, anything outside it is "the provider", and
 * `Object.hasOwn` rather than a bare lookup because a bare lookup answers
 * `__proto__`.
 */

/** The result codes the three callbacks redirect with. */
export type IntegrationCallbackOutcome = 'connected' | 'denied' | 'error' | 'retired';

/** A provider label the page is willing to print, or the neutral stand-in. */
export function providerLabel(labels: Record<string, string>, named: string | null): string {
  return (named !== null && Object.hasOwn(labels, named) ? labels[named] : undefined) ?? 'the provider';
}

/**
 * The sentence, and which voice it is said in.
 *
 * `ok` picks `SuccessNote` (`role="status"`) over `ErrorNote` (`role="alert"`),
 * which matters more here than anywhere else in the product: the browser has
 * just come back from a third party, nothing on the page is in a failed state,
 * and there is no request to have answered with a problem — this sentence is
 * the whole signal.
 *
 * A cancellation is stated as a refusal rather than as a fault. It is the
 * reader's own deliberate act, but the connection did not happen and the button
 * has to be pressed again, which is the thing they need to know.
 *
 * Every branch says whether anything was connected, because that is what
 * somebody who has just granted a third party access to their cap table most
 * wants to be told — and it is true of all three refusals: the retirement check
 * and the `denied` branch both sit above the token exchange, and a failed
 * exchange stored nothing.
 */
export function describeCallbackOutcome(
  outcome: string,
  provider: string,
  /** What the reader can do now, appended to the success sentence. */
  connectedNext: string,
): { ok: boolean; message: string } {
  switch (outcome) {
    case 'connected':
      return { ok: true, message: `Connected to ${provider} — ${connectedNext}` };
    case 'denied':
      return {
        ok: false,
        message: `Connection to ${provider} was cancelled — nothing was connected. Press Connect to try again.`,
      };
    case 'retired':
      // The engagement was withdrawn while the reader was on the provider's
      // consent screen. Not a fault of theirs and not one they can retry, so it
      // names the state rather than offering the button again.
      return {
        ok: false,
        message:
          `This engagement was retired while you were connecting to ${provider}, so nothing was ` +
          'connected and no access was granted. An admin has to restore it before it can accept ' +
          'integration changes.',
      };
    default:
      return {
        ok: false,
        message: `Connecting to ${provider} failed — nothing was connected. Press Connect to try again.`,
      };
  }
}
