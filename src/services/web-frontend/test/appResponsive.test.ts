import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-level responsive guards for the *authenticated* app.
 *
 * The marketing pages already have these (see marketingResponsive.test.ts); the
 * app — which is where the wide, number-dense tables actually live — had none.
 * The reasoning is the same: jsdom has no layout engine, so a rendering test
 * cannot observe that a table is 446px wide inside a 343px content box. What a
 * source test *can* do is pin the construct that causes it.
 *
 * The numbers quoted below are real. They were measured in a browser at a
 * 375px viewport by cloning each table into a `width: min-content` box, which
 * is the width below which it can no longer shrink — a phone narrower than
 * that has to scroll the whole page sideways. The budget is
 *
 *     375px viewport − AppLayout's `px-4` on both sides = 343px
 *
 * and a table over that dragged the entire page with it, because the money
 * columns (`tnum`, `$1,204,880,000.00`) have no wrap opportunity to give back.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

/** The content box a table gets on a 375px phone, in px. */
const PHONE_CONTENT_BOX = 343;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

/** Every .tsx under src/, keyed by its path relative to src/. */
const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file),
  text: readFileSync(file, 'utf8'),
}));

/** Class strings in the file, with any responsive/state prefix intact. */
function classNames(text: string): string[] {
  return [...text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .flatMap((m) => (m[1] ?? m[2] ?? '').split(/\s+/))
    .filter(Boolean);
}

type Table = { file: string; line: number; columns: number; scrolls: boolean; minWidth: boolean };

/**
 * Locate every real `<table>` and describe it: how many columns it declares,
 * whether an enclosing element scrolls horizontally, and whether it pins a
 * minimum width. The wrapper is always within a few lines of the tag in this
 * codebase, so a short look-back is enough and avoids parsing JSX properly.
 */
function tables(): Table[] {
  const found: Table[] = [];
  for (const { file, text } of FILES) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!/<table[\s>]/.test(line)) return;
      const lookBack = lines.slice(Math.max(0, i - 6), i).join(' ');
      // `overflow-y-auto` alone also scrolls horizontally — per CSS, an
      // overflow-x of `visible` computes to `auto` when the other axis is not
      // visible — but relying on that is invisible to a reader, so a table that
      // needs to scroll sideways has to say `overflow-x-auto`.
      const scrolls = /overflow-x-auto/.test(lookBack);

      // Columns: the `<th>`s of the first `<thead>`, or the `<td>`s of the
      // first row when the table is header-less.
      let columns = 0;
      let inHead = false;
      let sawHead = false;
      for (let j = i; j < Math.min(lines.length, i + 80); j++) {
        const row = lines[j] ?? '';
        if (/<\/table>/.test(row)) break;
        if (/<thead/.test(row)) inHead = sawHead = true;
        if (inHead) columns += [...row.matchAll(/<th[\s>/]/g)].length;
        if (/<\/thead>/.test(row)) break;
      }
      if (!sawHead) {
        let inRow = false;
        for (let j = i; j < Math.min(lines.length, i + 60); j++) {
          const row = lines[j] ?? '';
          if (/<tr[\s>]/.test(row)) inRow = true;
          if (inRow) columns += [...row.matchAll(/<td[\s>]/g)].length;
          if (inRow && /<\/tr>/.test(row)) break;
        }
      }
      found.push({
        file,
        line: i + 1,
        columns,
        scrolls,
        minWidth: /min-w-\[[\d.]+(?:px|rem)\]/.test(line),
      });
    });
  }
  return found;
}

const TABLES = tables();

describe('app data tables stay within a 375px viewport', () => {
  /**
   * Four-or-more-column tables that may sit outside a scroll container, each
   * with the min-content width measured in a browser. They fit the 343px
   * budget because their columns are prose or short tokens, which wrap; nothing
   * in them is an un-wrappable figure at fund scale.
   */
  const NARROW_ENOUGH = new Map([
    // PaymentSection's history table left this list rather than being
    // re-measured: its status cell now carries a refund/chargeback sentence
    // instead of one short token, which no longer fits the budget, so it went
    // into an overflow-x-auto box like the invoice table beside it.
    ['pages/SettingsPage.tsx:527', 228], // personal API tokens
    ['pages/FundPortfolioPage.tsx:618', 292], // position mark history
    ['pages/AdminSsoPage.tsx:220', 261], // SCIM tokens — label · created · state · revoke
    // Legal holds — scope · reason · state · release. Re-measured after the
    // action column gained an in-flight label: "Releasing…" is three glyphs
    // wider than "Release", which is the widest this cell now gets.
    ['pages/AdminRetentionPage.tsx:463', 297],
  ]);

  it('gives every table of four or more columns somewhere to scroll', () => {
    // Four columns is where the measurements crossed over: the six-column ESPP
    // table needed 446px and the ASC 820 hierarchy 405px, while every table
    // that fit was carrying wrapping text rather than money.
    const offenders = TABLES.filter(
      (t) => t.columns >= 4 && !t.scrolls && !NARROW_ENOUGH.has(`${t.file}:${t.line}`),
    ).map((t) => `${t.file}:${t.line} (${t.columns} columns)`);
    expect(offenders).toEqual([]);
  });

  it('keeps every allowlisted table inside the phone content box', () => {
    // The allowlist records a measurement, not an opinion. If one of these ever
    // gains a column it has to be re-measured rather than re-assumed.
    for (const [where, minContent] of NARROW_ENOUGH) {
      expect(minContent, `${where} no longer fits a 375px phone`).toBeLessThan(PHONE_CONTENT_BOX);
    }
  });

  it('still points at tables that exist', () => {
    // An allowlist entry whose table has moved or gone is worse than no entry:
    // it silently stops covering anything.
    for (const where of NARROW_ENOUGH.keys()) {
      const at = where.lastIndexOf(':');
      const file = where.slice(0, at);
      const line = Number(where.slice(at + 1));
      expect(
        TABLES.some((t) => t.file === file && t.line === line),
        `allowlist entry ${where} matches no table — re-measure and update it`,
      ).toBe(true);
    }
  });

  /**
   * The tables this suite was written for. Each was measured over the 343px
   * budget, so each must both scroll *and* pin a minimum width — a scroll
   * container on its own lets the table shrink to min-content instead, which
   * trades the horizontal scroll for six money columns crushed into 343px.
   */
  const MEASURED_OVER_BUDGET = [
    ['pages/valuation/Asc718Tab.tsx', 4, 355], // options — with a real grant label
    ['pages/valuation/Asc718Tab.tsx', 6, 446], // ESPP
    ['pages/valuation/Asc718Tab.tsx', 5, 410], // RSUs
    ['pages/valuation/Asc718Tab.tsx', 6, 410], // relative TSR
    ['pages/FundPortfolioPage.tsx', 3, 405], // ASC 820 hierarchy, at fund-scale NAV
    ['pages/DebtInstrumentsPage.tsx', 6, 481], // debt cash-flow schedule
  ] as const;

  it('scrolls and pins a width on every table measured over the budget', () => {
    for (const [file, columns, measured] of MEASURED_OVER_BUDGET) {
      expect(measured).toBeGreaterThan(PHONE_CONTENT_BOX);
      const matches = TABLES.filter((t) => t.file === file && t.columns === columns);
      expect(matches.length, `${file}: no ${columns}-column table found`).toBeGreaterThan(0);
      for (const t of matches) {
        expect(t.scrolls, `${file}:${t.line} needs a horizontal scroll container`).toBe(true);
        expect(t.minWidth, `${file}:${t.line} needs a min-w-[…] so it scrolls rather than crushes`).toBe(
          true,
        );
      }
    }
  });
});

describe('app grids collapse on a phone', () => {
  it('applies no unprefixed multi-column grid beyond two columns', () => {
    // A bare `grid-cols-3` never collapses. Three date-valued stats at
    // grid-cols-3 got ~95px each on a phone — and the ProgressTab skeleton
    // above it was already `grid-cols-2 sm:grid-cols-3`, so the strip visibly
    // reflowed the moment the data replaced the placeholder.
    const offenders: string[] = [];
    for (const { file, text } of FILES) {
      for (const cls of classNames(text)) {
        const match = /^grid-cols-(\d+)$/.exec(cls);
        if (match && Number(match[1]) > 2) offenders.push(`${file}: ${cls}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('applies no unjustified fixed pixel or rem width', () => {
    // Percentages and viewport units scale; `w-[34rem]` is 544px of guaranteed
    // horizontal scroll on a phone. `min-w-[…]` is exempt — those are the
    // deliberate widths inside the scroll containers checked above.
    const offenders: string[] = [];
    for (const { file, text } of FILES) {
      if (file.startsWith('pages/marketing') || file === 'components/MarketingLayout.tsx') continue;
      for (const cls of classNames(text)) {
        if (/^w-\[[\d.]+(?:px|rem)\]$/.test(cls)) offenders.push(`${file}: ${cls}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
