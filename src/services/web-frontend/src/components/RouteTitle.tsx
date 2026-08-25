import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Helmet } from 'react-helmet-async';
import { useLocation } from 'react-router-dom';
import { titleForPath } from '../lib/pageTitles';
import { pageTitle } from '../lib/seo';

/**
 * The `<title>` for every route that does not set its own — see
 * `lib/pageTitles.ts` for why the application had none at all.
 *
 * One component at the top of the router rather than a call in each page: a
 * page that forgets is then not a possibility, and the marketing pages that
 * *do* manage their own head tags opt out by being `null` in the registry, so
 * there is never a second `<title>` competing with `<Seo>`'s.
 */

const DetailContext = createContext<(d: string | null) => void>(() => {});

/**
 * Refine this route's title with something only the page knows.
 *
 * "Cap Table" is the right title for the tab and still not enough: an analyst
 * with four valuations open has four tabs reading `Cap Table · N409`, which is
 * exactly the ambiguity the registry was written to remove, one level down. The
 * company name is what tells them apart, and only the workspace has it — it
 * arrives with the valuation, after the route has already rendered.
 *
 * Pass `undefined` for "nothing to add yet". A caller whose detail can lag the
 * URL — the workspace's, which is loaded state — is responsible for withholding
 * it until it agrees with the route, exactly as it is for the heading it draws
 * on the page; this hook takes the caller's word for it.
 *
 * A no-op outside {@link RouteTitleProvider}, so a page can be rendered on its
 * own in a test without one.
 */
export function usePageTitleDetail(detail: string | null | undefined): void {
  const setDetail = useContext(DetailContext);
  useEffect(() => {
    if (!detail) return;
    setDetail(detail);
    // Cleared when the page that offered it goes away, or the title keeps
    // naming a valuation the user has navigated off.
    return () => setDetail(null);
  }, [setDetail, detail]);
}

/** Renders the `<title>`; kept separate so the provider can sit above it. */
function RouteTitle({ detail }: { detail: string | null }) {
  const { pathname } = useLocation();
  const base = titleForPath(pathname);
  if (base === null) return null;
  return (
    <Helmet>
      <title>{pageTitle(detail ? `${base} · ${detail}` : base)}</title>
    </Helmet>
  );
}

/**
 * Wraps the route tree: titles every route from the registry and accepts a
 * per-page refinement through {@link usePageTitleDetail}.
 */
export function RouteTitleProvider({ children }: { children: ReactNode }) {
  const [detail, setDetail] = useState<string | null>(null);
  // Stable identity: the setter is an effect dependency in every consumer, and
  // `useState` already guarantees `setDetail` never changes.
  const value = useMemo(() => setDetail, []);
  return (
    <DetailContext.Provider value={value}>
      <RouteTitle detail={detail} />
      {children}
    </DetailContext.Provider>
  );
}
