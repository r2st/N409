import { useCallback, useRef } from 'react';

/**
 * Order the replies to a request the user can re-issue before the first one
 * lands.
 *
 * Every list, picker and pager on this platform re-fetches when a dependency
 * changes — a filter, a tab, a page number, the other side of a comparison —
 * and nothing about `fetch` promises that two requests issued in order reply in
 * order. They routinely do not: the first query is the cold one, the second is
 * served from the same connection with a warm plan, and a slow first reply
 * lands *after* the fast second one and overwrites it.
 *
 * What that looks like is not an error. It is the previous answer, rendered
 * under the current controls, with no further request coming to correct it:
 * page 2's rows beneath a pager reading 3, the Published tab showing the Closed
 * list, one organization's holdings under another organization's name, the
 * value bridge against the comparable the analyst just navigated away from.
 * Every one of those is a screen someone reads a number off and puts in a board
 * pack, and every one of them is self-consistent enough to be believed.
 *
 * `setData(null)` before the request — which most of these call sites already
 * do — makes the spinner honest and does nothing about this: it is the *reply*
 * that is stale, and it arrives after the spinner it would have justified.
 *
 * Usage: claim a ticket before issuing the request, and let only the holder of
 * the newest ticket write state.
 *
 *     const claim = useLatestOnly();
 *     useEffect(() => {
 *       const current = claim();
 *       api(url)
 *         .then((d) => current() && setData(d))
 *         .catch(() => current() && setError('…'));
 *     }, [claim, dep]);
 *
 * The `catch` arm matters as much as the `then`: an abandoned request that
 * fails would otherwise put an error banner over results that loaded fine.
 *
 * This is deliberately not an `AbortController`. Aborting cancels the transfer,
 * which is the right thing for an expensive request and the wrong shape for the
 * problem — an aborted `fetch` rejects, so every call site would still need to
 * tell that rejection apart from a real failure before deciding whether to show
 * one. The ticket answers the only question the call site actually has, which
 * is whether it is still the newest.
 *
 * The returned function is stable for the component's life, so it is safe in a
 * dependency array and does not re-run the effect it guards.
 */
export function useLatestOnly(): () => () => boolean {
  const seq = useRef(0);
  return useCallback(() => {
    const ticket = ++seq.current;
    return () => ticket === seq.current;
  }, []);
}
