import { useEffect } from 'react';
import { Navigate, type NavigateFunction } from 'react-router-dom';
import { analyticsLoadedIn } from '../lib/analytics';

/**
 * The crossing from the public surface into the product, in a document that may
 * be carrying third-party analytics containers.
 *
 * `<Analytics>` will not inject once there is a session, which covers every
 * document that starts inside the product. It cannot cover the crossing: a
 * visitor who accepted the cookie banner on a marketing page and then signed in
 * is in a document that already loaded GTM, GA4 and the Meta Pixel, and a script
 * cannot be unloaded. GA4's page views on history changes are configured in the
 * property rather than on the page, so from that moment every product URL the
 * operator opens — an engagement id, a client's company name in a filter, the
 * address typed into the admin user search — is reported to Google and Meta.
 *
 * So the product is handed a *fresh document* when, and only when, this one is
 * carrying containers. That costs one full page load on the sign-in of a
 * visitor who consented in this session, and nothing at all otherwise —
 * including on every deployment with no container ids configured, which is why
 * the question is asked rather than assumed.
 *
 * Two shapes, because sign-in completes in two ways here: a render branch that
 * has watched the session flip (`LoginPage`, `RegisterPage`) and an imperative
 * callback that has just awaited it ({@link handOffAfterSignIn}).
 */
export function SignedInHandoff({ to }: { to: string }): React.JSX.Element | null {
  const loaded = analyticsLoadedIn();
  useEffect(() => {
    // `replace`, not `assign`: the sign-in form is not a page the back button
    // should return to, which is what `<Navigate replace>` says on the other
    // branch.
    if (loaded) window.location.replace(to);
  }, [loaded, to]);
  return loaded ? null : <Navigate to={to} replace />;
}

/** The same decision for a caller holding a `navigate` rather than rendering. */
export function handOffAfterSignIn(to: string, navigate: NavigateFunction): void {
  if (analyticsLoadedIn()) window.location.replace(to);
  else navigate(to, { replace: true });
}
