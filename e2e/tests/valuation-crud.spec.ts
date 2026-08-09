/**
 * Creating, listing, finding and archiving a valuation — the CRUD surface a
 * user touches before any modelling happens.
 */

import { expect, test, type Page } from '@playwright/test';
import { STORAGE_STATE } from '../support/accounts';

test.use({ storageState: STORAGE_STATE.admin });

/** Unique per run so the list assertions below cannot match a leftover row. */
function uniqueCompany(prefix: string): string {
  return `${prefix} ${Date.now().toString(36).toUpperCase()}`;
}

/**
 * The list renders twice — a table for desktop and a `md:hidden` card list for
 * mobile — and both are in the DOM at every viewport. A bare text match
 * therefore resolves to two nodes, one of them permanently hidden, and
 * `.first()` picks whichever the markup happens to order first. Every
 * list assertion goes through here so it is about what a user can see.
 */
function visibleText(page: Page, text: string) {
  return page.getByText(text).filter({ visible: true });
}

/** Search is applied on submit/blur, not on keystroke, so it has to be committed. */
async function search(page: Page, term: string) {
  await page.getByLabel('Search').fill(term);
  await page.getByLabel('Search').press('Enter');
}

async function createValuation(page: Page, company: string) {
  await page.goto('/valuations/new');
  await page.getByLabel('Company legal name').fill(company);
  await page.getByLabel('Currency').fill('USD');
  await page.getByRole('button', { name: /^(create|start)/i }).click();
  // Creation lands in the workspace, whose URL carries the new id.
  await expect(page).toHaveURL(/\/valuations\/[A-Z0-9]+/i, { timeout: 30_000 });
  const id = page.url().match(/\/valuations\/([A-Z0-9]+)/i)?.[1];
  expect(id, 'the new valuation id should be in the URL').toBeTruthy();
  return id!;
}

test.describe('creating a valuation', () => {
  test('a new engagement is created and opens its workspace', async ({ page }) => {
    const company = uniqueCompany('Cedar Robotics');
    await createValuation(page, company);
    await expect(page.getByText(company).first()).toBeVisible();
  });

  test('it then appears in the list', async ({ page }) => {
    const company = uniqueCompany('Alder Biosciences');
    await createValuation(page, company);

    await page.goto('/valuations');
    await expect(page.getByRole('heading', { name: /valuations/i }).first()).toBeVisible();
    await expect(visibleText(page, company).first()).toBeVisible();
  });

  test('the form refuses to submit without a company name', async ({ page }) => {
    await page.goto('/valuations/new');
    await page.getByLabel('Currency').fill('USD');
    // The submit is disabled until the name is there — assert the guard rather
    // than clicking and hoping, so a regression that merely *hides* the error
    // still fails here.
    await expect(page.getByRole('button', { name: /^(create|start)/i })).toBeDisabled();
  });

  test('a currency that is not three letters is refused', async ({ page }) => {
    await page.goto('/valuations/new');
    await page.getByLabel('Company legal name').fill('Bad Currency Co');
    // Too long is not the case to test: the input carries maxLength={3}, so
    // "DOLLARS" arrives as "DOL" and is perfectly valid. The reachable invalid
    // state is a code that is too *short*.
    await page.getByLabel('Currency').fill('US');
    await expect(page.getByRole('button', { name: /^(create|start)/i })).toBeDisabled();

    await page.getByLabel('Currency').fill('EUR');
    await expect(page.getByRole('button', { name: /^(create|start)/i })).toBeEnabled();
  });
});

test.describe('finding a valuation', () => {
  test('search narrows the list to the matching engagement', async ({ page }) => {
    const target = uniqueCompany('Juniper Systems');
    const other = uniqueCompany('Sequoia Metals');
    await createValuation(page, target);
    await createValuation(page, other);

    await page.goto('/valuations');
    await search(page, target);
    // Wait for the row that must go, not a fixed sleep.
    await expect(page.getByText(other)).toHaveCount(0, { timeout: 20_000 });
    await expect(visibleText(page, target).first()).toBeVisible();
  });
});

test.describe('the workspace tabs', () => {
  test('every pipeline tab renders rather than erroring', async ({ page }) => {
    const id = await createValuation(page, uniqueCompany('Tabwalk Inc'));

    // A blank-page regression in a lazily loaded tab is invisible until someone
    // opens it. Walking them is cheap and catches an import that throws.
    for (const tab of [
      'company',
      'cap-table',
      'model',
      'params',
      'documents',
      'calculations',
      'report',
      'audit-trail',
      'qa',
    ]) {
      await page.goto(`/valuations/${id}/${tab}`);
      await expect(page.locator('main')).toBeVisible();
      // React error boundaries and unhandled route errors both surface as text.
      await expect(page.getByText(/something went wrong|unexpected error/i)).toHaveCount(0);
    }
  });
});

/*
 * There is no archiving spec here on purpose.
 *
 * This file used to carry one that skipped itself when it could not find an
 * archive control, which is how it passed: there is no such control anywhere in
 * the frontend, and archiving is not a user-facing action at all. It is the
 * retention sweep's, driven by policy age rather than by a button. A spec that
 * skips on a condition that is *always* true reports "skipped" — read as
 * temporarily disabled — for a capability the product does not offer.
 *
 * The behaviour it was reaching for is real and now covered where it can
 * actually be exercised: `test/integration/retention.test.ts` archives through
 * the sweep and asserts the engagement leaves the list, the count and the
 * search. If archiving ever becomes something a user does, it belongs back
 * here — as a test that fails when the button is missing.
 */
