import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The register of surfaces that re-read a list when the user changes what they
 * are asking for, and how each one stops the previous answer being shown as the
 * answer to the new question.
 *
 * `useLatestOnly` is the reliable marker for this shape: a component reaches
 * for it precisely because a dependency the user controls can put two requests
 * in flight at once. It solves the reply that lands out of order and leaves the
 * wait, which is the longer of the two windows and the one a reader is more
 * likely to be looking at — the chip pressed, the rows underneath it belonging
 * to the filter before last, nothing saying so.
 *
 * Three mechanisms are legitimate, and the register records which each surface
 * uses rather than accepting any of them silently:
 *
 * - `clear-hook`: `useClearOnChange`, which drops the answer when the question
 *   changes and leaves it alone when the same question is re-asked. Required
 *   wherever a Refresh button or a poll shares the loader.
 * - `clears-in-loader`: the answer is emptied on the path that issues the
 *   request. Fine where nothing else calls it.
 * - `tagged`: the answer is stored with the question it answers and read back
 *   only for a match (`loaded.forId === id`). Strictly the strongest of the
 *   three — there is no window at all — and the right shape when the question
 *   is a route parameter.
 * - `same-question`: there is no changing question. The surface re-reads only
 *   on an explicit Refresh, so two replies in flight answer the same ask and
 *   the guard exists solely to stop the slower one repainting over the newer.
 *   Nothing is cleared, because nothing on screen has stopped being the answer.
 *   An entry here has to state *why* the question cannot change — a filter
 *   added later turns this into one of the three above.
 *
 * The register is asserted to be exactly the set of files using the hook, in
 * both directions. A new racing surface fails this until someone writes down
 * which of the three it uses, which is the point: the failure mode this guards
 * is not a mechanism done wrong, it is one nobody thought about.
 */

type Mechanism = 'clear-hook' | 'clears-in-loader' | 'tagged' | 'same-question';

const REGISTER: Record<string, { mechanism: Mechanism; question: string }> = {
  'pages/AdminApiTokensPage.tsx': { mechanism: 'clear-hook', question: 'include revoked' },
  'pages/AdminJobsPage.tsx': { mechanism: 'clear-hook', question: 'source, status, page' },
  'pages/AdminUsersPage.tsx': {
    mechanism: 'clear-hook',
    question: 'search, role, partner, include deleted, page',
  },
  'pages/CommunicationsPage.tsx': { mechanism: 'clear-hook', question: 'template category' },
  'pages/EmailOutboxPage.tsx': { mechanism: 'clear-hook', question: 'delivery scope' },
  'components/SuppressionList.tsx': { mechanism: 'clear-hook', question: 'show released' },
  'pages/InboxPage.tsx': { mechanism: 'clear-hook', question: 'kind, unread only, search, page' },
  'pages/PartnerDetailPage.tsx': { mechanism: 'clear-hook', question: 'engagement page' },
  'pages/SupportInboxPage.tsx': { mechanism: 'clear-hook', question: 'triage scope' },
  'pages/marketing/BlogPages.tsx': { mechanism: 'clear-hook', question: 'post slug' },

  'pages/FirmDashboardPage.tsx': {
    mechanism: 'clears-in-loader',
    // Inside the 250ms debounce rather than on the keystroke, so the book stays
    // readable through the typing pause.
    question: 'client search, page',
  },
  'pages/PortfolioPage.tsx': { mechanism: 'clears-in-loader', question: 'selected organization' },
  'pages/ValuationComparePage.tsx': { mechanism: 'clears-in-loader', question: 'the two sides' },
  'pages/ValuationsPage.tsx': {
    mechanism: 'clears-in-loader',
    question: 'filters, tab, sort, page',
  },
  'pages/valuation/BridgeTab.tsx': { mechanism: 'clears-in-loader', question: 'comparable' },

  'pages/valuation/ValuationWorkspace.tsx': { mechanism: 'tagged', question: 'valuation id' },

  'pages/AdminOperationsPage.tsx': {
    mechanism: 'same-question',
    // Deliberately unfiltered and unpolled: it is the incident view, and every
    // control on it is an action rather than a question. Refresh is the only
    // way to re-read, so the guard is against a slow first reply landing after
    // a fast second one — never against rows answering a filter nobody set.
    question: 'none — Refresh only',
  },
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

const racing = FILES.filter(({ text }) => /\buseLatestOnly\b/.test(text)).map(({ file }) => file);

describe('every surface that re-reads on a user-controlled dependency is registered', () => {
  it('names every file that reaches for useLatestOnly', () => {
    const unregistered = racing.filter((file) => !(file in REGISTER));
    expect(
      unregistered,
      'a new racing surface: decide how it drops the previous answer, then register it',
    ).toEqual([]);
  });

  it('carries no register entry for a surface that no longer races', () => {
    const stale = Object.keys(REGISTER).filter((file) => !racing.includes(file));
    expect(stale, 'these files no longer use useLatestOnly; drop their entries').toEqual([]);
  });

  it('finds the mechanism each entry claims in the file itself', () => {
    const wrong = Object.entries(REGISTER).filter(([file, { mechanism }]) => {
      const text = FILES.find((f) => f.file === file)!.text;
      if (mechanism === 'clear-hook') return !/\buseClearOnChange\(/.test(text);
      // Both remaining mechanisms are asserted on the shape that implements
      // them, so an entry cannot go on claiming a mechanism that was edited
      // away — the case a register kept by hand is otherwise prone to.
      if (mechanism === 'clears-in-loader') return !/\bset[A-Z]\w*\(null\)/.test(text);
      /*
       * "The question cannot change" is not prose here — it is the loader's
       * dependency list holding nothing but the claim. Add a filter to the
       * page and that list grows, this fails, and the surface has to be
       * reclassified as one of the three mechanisms above rather than quietly
       * keeping an entry that stopped being true.
       */
      if (mechanism === 'same-question') return !/\}, \[claim\]\);/.test(text);
      return !/\.forId === /.test(text);
    });
    expect(
      wrong.map(([file]) => file),
      'the register claims a mechanism the file does not use',
    ).toEqual([]);
  });

  it('reserves the clearing hook for surfaces that race', () => {
    // The hook is cheap but it is also a claim about why it is there. A file
    // using it without `useLatestOnly` either needs the ticket too, or is
    // reaching for the wrong tool.
    const clearsWithoutRacing = FILES.filter(
      ({ file, text }) => /\buseClearOnChange\(/.test(text) && !racing.includes(file),
    ).map(({ file }) => file);
    expect(clearsWithoutRacing).toEqual([]);
  });
});
