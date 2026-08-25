import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { SITE_NAME } from '../lib/seo';

/**
 * Says out loud which page the user has just arrived at.
 *
 * Titling every route (see `lib/pageTitles.ts`) fixes the tab strip, the history
 * menu and the bookmark. It does not, on its own, tell a screen-reader user
 * anything: a full page load is what makes a browser present a document and
 * announce its title, and this application never does one. Every navigation is
 * a `pushState` and a re-render, after which the reader's virtual buffer is
 * silently replaced. The user activates "Cap Table" and hears nothing at all —
 * and then has to go looking for what, if anything, changed.
 *
 * A polite live region is the standard answer, and the details are most of it:
 *
 *  - The region is in the DOM from the first render with *empty* content. A
 *    live region that is inserted already populated is frequently not announced
 *    at all; what assistive technology watches for is a change inside a region
 *    it was already tracking.
 *  - Nothing is announced for the first location. The browser has just loaded a
 *    document and read its title; saying it a second time is noise.
 *  - The text comes from `document.title`, so this stays correct for the
 *    marketing pages, whose titles come from `<Seo>` and not from the registry.
 *    Reading it in the same commit is safe in both directions: react-helmet-async
 *    applies the title in a layout effect, which is ordered before every passive
 *    effect regardless of where in the tree the two components sit.
 *  - The brand suffix is dropped. It is useful in a tab strip, where the tabs
 *    of six applications compete; it is four syllables of nothing on every
 *    single navigation.
 *
 * A redirect through a route — `/` resolving to the dashboard or the partner
 * portal, a guard sending a visitor to sign in — needs no special handling. Two
 * locations commit in one batch, so the pass-through's title is a value the live
 * region never holds in the DOM, and only what a reader can observe is announced.
 *
 * Focus is deliberately left where the user put it. Moving it to the main
 * landmark on every navigation is the other common pattern, and it takes a
 * keyboard user out of the sidebar they were tabbing through. `SkipLink` is
 * what exists for people who want to jump to the content, on demand.
 */
export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const [message, setMessage] = useState('');
  const announced = useRef<string | null>(null);

  useEffect(() => {
    // The first location, and StrictMode's re-run of this effect for it, both
    // arrive with the pathname already recorded.
    if (announced.current === pathname) return;
    const first = announced.current === null;
    announced.current = pathname;
    if (first) return;

    setMessage(withoutBrand(document.title));
  }, [pathname]);

  return (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </p>
  );
}

/** `Cap Table · Acme, Inc. · N409` → `Cap Table · Acme, Inc.` */
function withoutBrand(title: string): string {
  const suffix = ` · ${SITE_NAME}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}
