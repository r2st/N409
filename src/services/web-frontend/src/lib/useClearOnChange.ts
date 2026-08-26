import { useEffect, useRef } from 'react';

/**
 * Discard an answer when the question changes.
 *
 * `useLatestOnly` orders the replies to a re-issued request, and stops there:
 * whatever is on screen when the user changes a filter stays on screen until
 * the new reply lands. For the whole of that window the controls and the rows
 * disagree, and nothing on the page says so — the Failed chip is pressed, the
 * table underneath it holds the sent message that was there a moment ago, and
 * there is no spinner, no dimming and no live-region announcement to mark the
 * difference. A reader who looks during that window is not told a stale answer;
 * they are told *this is what Failed contains*.
 *
 * That window is not short. It is a network round trip on a list endpoint, and
 * it opens on exactly the interaction that means the user has stopped believing
 * the current rows and asked for different ones.
 *
 * The surfaces this bites are the ones whose loader takes a user-facing filter
 * in its dependencies: a scope chip, a tab, a checkbox, a page number, a
 * committed search, the selected row of a sidebar. `ValuationsPage` had it
 * right by hand — `setData(null)` at the top of the loader, so the existing
 * `if (!data) return <Spinner />` covers the gap. That spelling does not
 * generalise, because the same loader is also what a Refresh button and a
 * 15-second poll call, and blanking the page every fifteen seconds to prove a
 * point about freshness is worse than the bug.
 *
 * So the clearing is keyed on the question rather than attached to the request.
 * Re-asking the same question keeps the rows; asking a different one drops
 * them. Pass the current question as a string and the reset that empties
 * whatever state renders the answer:
 *
 *     useClearOnChange(scope, () => setEmails(null));
 *     useClearOnChange(`${source}|${status}|${page}`, () => setJobs(null));
 *
 * Nothing fires on the first run — the state is already empty, and clearing it
 * again would only cost a render. `clear` is read through a ref, so a call site
 * may pass a fresh closure each render without re-running anything.
 *
 * This runs in an effect, alongside the effect that issues the load, and the
 * two are independent: the load is asynchronous, so the order they run in
 * within the commit cannot change what the user sees.
 */
export function useClearOnChange(question: string, clear: () => void): void {
  const latest = useRef(clear);
  latest.current = clear;
  const asked = useRef<string | null>(null);

  useEffect(() => {
    if (asked.current !== null && asked.current !== question) latest.current();
    asked.current = question;
  }, [question]);
}
