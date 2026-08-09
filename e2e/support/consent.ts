/**
 * The cookie-consent banner, dealt with once.
 *
 * It is a `position: fixed` dialog across the bottom of the viewport, so until
 * it is answered it intercepts pointer events for anything beneath it — which
 * includes the sidebar's "Sign out". Every spec would otherwise fail on a
 * timeout whose call log blames the control it was trying to click rather than
 * the banner covering it.
 *
 * The answer is "Decline": these tests should exercise the app in its
 * least-instrumented state, and a suite that clicks "Accept" is a suite that
 * silently turns analytics on for every run.
 */

import type { Page } from '@playwright/test';

export const CONSENT_STORAGE_KEY = 'n409-cookie-consent';

/**
 * Pre-answer the banner for a context that has not loaded the app yet. Used by
 * the setup project so the banked storage states carry the decision and no
 * other spec ever meets the dialog.
 */
export async function denyConsentInStorage(page: Page): Promise<void> {
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [CONSENT_STORAGE_KEY, 'denied'] as const,
  );
}

/**
 * Dismiss the banner if it is on screen. For specs that deliberately start from
 * a blank storage state and so meet it for real.
 */
export async function declineConsent(page: Page): Promise<void> {
  const decline = page.getByRole('button', { name: 'Decline' });
  if (await decline.isVisible().catch(() => false)) {
    await decline.click();
    await decline.waitFor({ state: 'hidden' });
  }
}
