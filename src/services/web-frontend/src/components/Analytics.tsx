import { useEffect } from 'react';
import {
  analyticsConfigFromEnv,
  hasAnyAnalytics,
  injectAnalytics,
  type AnalyticsConfig,
} from '../lib/analytics';
import { useConsent } from '../lib/consent';

export interface AnalyticsProps {
  /** Override the env-derived config (used in tests). */
  config?: AnalyticsConfig;
}

/**
 * Consent-gated analytics loader (409.ai §23 + §25). Renders nothing; when the
 * visitor has granted cookie consent and at least one provider id is configured,
 * it injects GTM / GA4 / the Facebook Pixel. Injection is idempotent, so this
 * safely re-runs when consent flips from the cookie banner.
 */
export function Analytics({ config }: AnalyticsProps): null {
  const { consent } = useConsent();
  const resolved = config ?? analyticsConfigFromEnv();

  useEffect(() => {
    if (consent !== 'granted') return;
    if (!hasAnyAnalytics(resolved)) return;
    injectAnalytics(resolved);
  }, [consent, resolved]);

  return null;
}
