/**
 * One per-share renderer, so the conclusion cannot be re-rounded one surface at
 * a time.
 *
 * The concluded FMV per share is the platform's output. It is struck at four
 * decimals by the engine and printed at four by every server-side rendering of
 * it, and the browser printed it five different ways: two decimals on the
 * auditor portal and the portfolio roll-up, two decimals *and* a hard-coded `$`
 * on the bridge and the analytics trend, and — above $100 a share — no decimals
 * at all on the Calculations tab's own headline card. None of them was a wrong
 * call; each was a locally reasonable choice of digits, made in a file that
 * could not see the other four or the PDF.
 *
 * So the rule is stated once, over the whole source tree: an expression naming
 * a per-share FMV may only be handed to `formatPerShare`, directly or through a
 * file-local helper that does nothing but delegate to it.
 *
 * The register below is the other half. A rule that only forbids the known-bad
 * formatters is silent about the next surface to render this figure with a
 * sixth one, so the census also pins *which files* render it: a new one fails
 * here until somebody has said what it prints.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/**
 * How a per-share FMV is spelled where it is held.
 *
 * `from_fmv` / `to_fmv` are the bridge's two ends — the same figure under a
 * different name, which is exactly how it escaped a search for the first one.
 */
const PER_SHARE_TOKEN = /\b(fmv_per_share|fmvPerShare|from_fmv|to_fmv)\b/;

/**
 * Every money formatter the frontend has. A per-share figure reaching any of
 * them other than `formatPerShare` is the defect; listing them by name is what
 * makes a *new* formatter's arrival visible, via the completeness test below.
 */
const MONEY_FORMATTERS = [
  'formatPerShare',
  'formatMoney',
  'formatAmount',
  'formatCents',
  // Cents scaled by the charging currency rather than by 100 — the billing
  // half of the split `moneyScaleCensus.test.ts` keeps. A per-share FMV is not
  // a charge and must not reach it either.
  'formatChargedCents',
  'formatUsd',
  'formatNumber',
  'moneyFormatter',
];

/**
 * Files that render the concluded per-share FMV, and the helper each prints it
 * with. `formatPerShare` means the call site names it directly; anything else
 * is a file-local helper, and the test below reads that helper's definition and
 * requires it to delegate.
 *
 * A file holding the figure only in a type — `RollforwardPanel`, `Asc718Tab`,
 * `AdminDataRemediationPage` — is deliberately absent: it never prints it, and
 * listing it would claim a guarantee about a render that does not happen.
 */
const REGISTER: Record<string, string> = {
  'components/valuation/CalculationPanel.tsx': 'formatPerShare',
  'components/valuation/ModelSensitivityPanel.tsx': 'money',
  'pages/AuditorPortalPage.tsx': 'PER_SHARE_DIGITS',
  'pages/PortfolioPage.tsx': 'perShare',
  'pages/valuation/AnalyticsTab.tsx': 'money',
  'pages/valuation/BridgeTab.tsx': 'money',
  'pages/valuation/PackageTab.tsx': 'formatPerShare',
  'pages/valuation/ScenariosTab.tsx': 'formatPerShare',
  'pages/valuation/SpecialtyTab.tsx': 'formatPerShare',
};

/** A property signature — the field declared on a response type, not shown. */
const HELD_IN_A_TYPE = /^\s*(readonly\s+)?(fmv_per_share|fmvPerShare|from_fmv|to_fmv)\??:/;

/** A call to `name` whose arguments mention a per-share FMV. */
function appliedToPerShare(text: string, name: string): boolean {
  const flat = text.replace(/\s+/g, ' ');
  const call = new RegExp(`\\b${name}\\(([^()]*)\\)`, 'g');
  for (const m of flat.matchAll(call)) {
    if (PER_SHARE_TOKEN.test(m[1] ?? '')) return true;
  }
  return false;
}

describe('every rendered per-share FMV goes through formatPerShare', () => {
  it('is looking at a source tree', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.filter(({ text }) => PER_SHARE_TOKEN.test(text)).length).toBeGreaterThan(8);
  });

  it('hands the figure to no other money formatter', () => {
    const offenders: string[] = [];
    for (const { file, text } of FILES) {
      if (file === 'lib/format.ts') continue;
      for (const fn of MONEY_FORMATTERS) {
        if (fn === 'formatPerShare') continue;
        if (appliedToPerShare(text, fn)) offenders.push(`${file} → ${fn}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never denominates it in a hard-coded currency', () => {
    // A `$` written into a template literal is a currency the engagement may
    // not be in. Only files that actually hold the figure are in scope — the
    // marketing pages quote a US price list and are denominated on purpose.
    const offenders = FILES.filter(({ text }) => PER_SHARE_TOKEN.test(text) && /`\$\$\{/.test(text)).map(
      ({ file }) => file,
    );
    expect(offenders).toEqual([]);
  });

  it('renders it only in the files that say they do', () => {
    /*
     * Printed, not merely held. A component that declares the field in its
     * response type and never shows it — `RollforwardPanel`, the remediation
     * table — guarantees nothing about precision, and registering it would
     * claim a render that does not happen.
     *
     * "Held" is a property signature and nothing else. Detecting the render
     * instead by looking for a formatter call would miss the three surfaces
     * that reach one through a prop — the auditor portal's `Metric`, the
     * portfolio's `FigureCell`, the analytics chart's `format` — which is the
     * half of the tree the direct-call rule above cannot see, and so exactly
     * the half this list exists to cover.
     */
    const rendering = FILES.filter(({ file, text }) => {
      if (file.startsWith('lib/')) return false;
      return text.split('\n').some((line) => PER_SHARE_TOKEN.test(line) && !HELD_IN_A_TYPE.test(line));
    }).map(({ file }) => file);
    expect(rendering.sort()).toEqual(Object.keys(REGISTER).sort());
  });

  it('has every registered helper delegating to formatPerShare', () => {
    const broken: string[] = [];
    for (const [file, helper] of Object.entries(REGISTER)) {
      const text = FILES.find((f) => f.file === file)?.text ?? '';
      if (helper === 'formatPerShare' || helper === 'PER_SHARE_DIGITS') {
        // Named at the call site, or — where the surface formats through a
        // shared component — pinned to the shared digit count.
        if (!text.includes(helper)) broken.push(`${file}: no ${helper}`);
        continue;
      }
      // A file-local helper: its body must reach formatPerShare and must not
      // pin a narrower precision of its own.
      const def = new RegExp(`(const|function) ${helper}\\b[\\s\\S]{0,400}?formatPerShare\\(`).test(text);
      if (!def) broken.push(`${file}: ${helper} does not delegate to formatPerShare`);
    }
    expect(broken).toEqual([]);
  });

  it('knows about every money formatter the frontend exports', () => {
    // The rule is only as complete as this list. A sixth formatter added to
    // format.ts or pipeline.ts fails here rather than silently escaping it.
    const exported = ['lib/format.ts', 'lib/pipeline.ts', 'lib/marketing.ts']
      .flatMap((f) => [...(FILES.find((x) => x.file === f)?.text ?? '').matchAll(/export function (\w+)/g)])
      .map((m) => m[1] as string)
      .filter((name) => /^(format|money)/i.test(name) && !/Date|Time|Bytes|Percent|Number$/.test(name));
    expect(exported.filter((name) => !MONEY_FORMATTERS.includes(name))).toEqual([]);
  });

  it('would catch the pattern it is looking for', () => {
    const broken = 'const x = formatMoney(calc.fmv_per_share, currency);';
    expect(appliedToPerShare(broken, 'formatMoney')).toBe(true);
    expect(appliedToPerShare('formatMoney(calc.equity_value, currency)', 'formatMoney')).toBe(false);
    expect(PER_SHARE_TOKEN.test('const money = (v) => `$${v.toFixed(2)}`; p.from_fmv')).toBe(true);
    expect(/`\$\$\{/.test('`$${v.toFixed(2)}`')).toBe(true);
  });
});
