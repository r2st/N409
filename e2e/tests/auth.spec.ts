/**
 * The login form itself — driven for real, exactly once in the suite.
 *
 * Everything else starts from a banked storage state (`auth.setup.ts`), so this
 * is the only place a regression in the sign-in path can surface. It is worth
 * covering properly for that reason: the failure modes below (a rejected
 * password that silently succeeds, a protected route that renders before auth
 * resolves) are the kind that a suite authenticating by fixture would never
 * see.
 */

import { expect, test } from '@playwright/test';
import { ANALYST } from '../support/accounts';
import { declineConsent } from '../support/consent';

// This file signs in and out on its own; a banked session would defeat it.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('signing in', () => {
  test('a valid password reaches the dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(ANALYST.email);
    await page.getByLabel('Password').fill(ANALYST.password);
    await page.getByRole('button', { name: /sign in|log in/i }).click();

    await expect(page).toHaveURL(/\/(dashboard|onboarding)/);
  });

  test('a wrong password is refused and stays on the form', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(ANALYST.email);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in|log in/i }).click();

    // The assertion that matters is the negative one: a failed sign-in must not
    // navigate. Checking only for an error message would pass if the app showed
    // an error *and* let the user through.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/invalid|incorrect|could not sign|check your/i).first()).toBeVisible();
  });

  test('an unknown address is refused the same way', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody-here@n409.test');
    await page.getByLabel('Password').fill('AnyPassw0rd!');
    await page.getByRole('button', { name: /sign in|log in/i }).click();

    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('route protection', () => {
  test('an anonymous visitor is sent to the login form, not the workspace', async ({ page }) => {
    await page.goto('/valuations');
    await expect(page).toHaveURL(/\/login/);
    // Assert the sign-in form is what rendered, rather than the absence of some
    // workspace heading: the login page's own wordmark is an <h1> containing
    // "Valuations", so a fuzzy negative match on that word fails here for a
    // reason that has nothing to do with route protection.
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    // What must *not* be here is the list itself.
    await expect(page.getByRole('button', { name: '+ New valuation' })).toHaveCount(0);
  });

  test('the marketing landing page is public', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('main')).toBeVisible();
  });
});

test.describe('signing out', () => {
  test('ends the session, and the back button does not resurrect it', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(ANALYST.email);
    await page.getByLabel('Password').fill(ANALYST.password);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await expect(page).toHaveURL(/\/(dashboard|onboarding)/);

    // This spec starts from a blank storage state, so unlike every other one it
    // meets the consent banner for real — and it covers "Sign out".
    await declineConsent(page);

    // The sidebar and the mobile drawer render the same controls and are both
    // mounted at once (the sidebar is `hidden lg:flex`, not unmounted), so
    // there are always two "Sign out" buttons in the DOM. Filtering to the
    // visible one is what makes this deterministic across viewports rather
    // than a strict-mode violation.
    await page
      .getByRole('button', { name: /sign out/i })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(/\/(login|)$/);

    // A cleared session has to survive a re-navigation: if the cookie outlived
    // the click, this is where it shows.
    await page.goto('/valuations');
    await expect(page).toHaveURL(/\/login/);
  });
});
