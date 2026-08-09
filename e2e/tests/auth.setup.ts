/**
 * Creates the suite's accounts and banks a signed-in browser state for each.
 *
 * Every other spec starts already authenticated from these files. That is not
 * only about speed: a login form driven 40 times is 40 chances for an unrelated
 * change to the login page to fail a cap-table test, and a red test should name
 * the thing that broke. `auth.spec.ts` drives the real form, once, on purpose.
 */

import { expect, test as setup } from '@playwright/test';
import {
  ADMIN,
  ANALYST,
  STORAGE_STATE,
  ensureAccount,
  grantRoles,
  markVerified,
} from '../support/accounts';
import { denyConsentInStorage } from '../support/consent';

const API = 'http://127.0.0.1:3001';

setup('create the analyst account and bank its session', async ({ page }) => {
  await ensureAccount(API, ANALYST);
  await markVerified(ANALYST.email);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ANALYST.email);
  await page.getByLabel('Password').fill(ANALYST.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();

  await expect(page).toHaveURL(/\/(dashboard|onboarding)/, { timeout: 30_000 });
  // Bank the consent decision with the session, so no other spec has to meet a
  // fixed-position dialog that intercepts clicks meant for the app beneath it.
  await denyConsentInStorage(page);
  await page.context().storageState({ path: STORAGE_STATE.analyst });
});

setup('create the admin account and bank its session', async ({ page }) => {
  await ensureAccount(API, ADMIN);
  await markVerified(ADMIN.email);
  // `admin` for the consoles, `supervisor` for user management, `reviewer` so
  // the QA surfaces render rather than 403 behind a blank page.
  await grantRoles(ADMIN.email, ['admin', 'supervisor', 'reviewer']);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();

  await expect(page).toHaveURL(/\/(dashboard|onboarding)/, { timeout: 30_000 });
  await denyConsentInStorage(page);
  await page.context().storageState({ path: STORAGE_STATE.admin });
});
