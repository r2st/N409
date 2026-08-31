import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  analyticsConfigFromEnv,
  hasAnyAnalytics,
  injectAnalytics,
  type AnalyticsConfig,
} from '../lib/analytics';
import { useConsent } from '../lib/consent';
import { useAuth } from '../lib/auth';

export interface AnalyticsProps {
  /** Override the env-derived config (used in tests). */
  config?: AnalyticsConfig;
}

/**
 * Consent-gated analytics loader (409.ai §23 + §25). Renders nothing; when the
 * visitor has granted cookie consent, has no session, and at least one provider
 * id is configured, it injects GTM / GA4 / the Facebook Pixel. Injection is
 * idempotent, so this safely re-runs when consent flips from the cookie banner.
 *
 * The session gate is the second condition and it is not a refinement of the
 * first. Consent is about cookies; this is about *what a page view carries*.
 * These containers are given the URL, and this SPA serves the marketing site
 * and the signed-in product from one document — so a container running inside
 * the product reports engagement ids, a client's company name typed into a
 * filter, and, on the admin user search, the address an operator typed to find
 * somebody. Consenting to analytics on a pricing page is not consent to that.
 *
 * `status === 'anonymous'` is the predicate rather than a list of product
 * paths: a signed-out visitor cannot reach a product route, so the session
 * answers the same question without a second copy of the router to keep in
 * step. `'loading'` deliberately does not inject — it is what a hard reload of
 * a product URL looks like for the first few hundred milliseconds, and
 * injecting on the optimistic reading is how the gate would fail exactly where
 * it matters. The effect re-runs when the status resolves.
 */
export function Analytics({ config }: AnalyticsProps): null {
  const { consent } = useConsent();
  const { status } = useAuth();
  const location = useLocation();
  const resolved = config ?? analyticsConfigFromEnv();

  useEffect(() => {
    if (consent !== 'granted') return;
    if (status !== 'anonymous') return;
    if (!hasAnyAnalytics(resolved)) return;
    injectAnalytics(resolved);
    // `location` is in the deps but not read: `injectAnalytics` reads the
    // address bar itself, and refuses while it holds a credential
    // (`urlCarriesCredential`). That refusal has to be re-askable or it would
    // switch analytics off for the rest of a document that happened to open on
    // a token link — so the effect re-runs per navigation, and the first URL
    // that is not carrying one gets the containers. Injection is idempotent,
    // so the repeat costs nothing on every other route.
  }, [consent, status, resolved, location]);

  return null;
}
