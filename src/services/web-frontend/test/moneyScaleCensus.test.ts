/**
 * Which integer means what, per surface.
 *
 * Two families of `*_cents` column share one spelling and disagree about the
 * unit. The app's own are hundredths of the major unit whatever the currency,
 * because the form that wrote them multiplied the analyst's number by 100.
 * Stripe's are the currency's own minor unit, and the zero-decimal currencies
 * have none — a ¥100,000 charge arrives as `100000`, so dividing it by 100 told
 * the customer they had paid ¥1,000.
 *
 * `formatCents` and `formatChargedCents` are the two rules. They agree in every
 * currency that has cents, which is why one formatter covering both looked
 * right for as long as it did, and it is why the split cannot be maintained by
 * reading a call site. So it is maintained here: each surface is registered
 * with the family it renders, and a file that reaches for the other formatter
 * fails rather than quietly rescaling somebody's money.
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

const FILES = walk(SRC)
  .map((file) => ({
    file: path.relative(SRC, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }))
  .filter(({ file }) => file !== 'lib/format.ts');

/** Surfaces rendering money the payment processor reported. */
const CHARGED = [
  'components/PaymentSection.tsx',
  'components/SubscriptionSection.tsx',
  'pages/BillingPage.tsx',
  'pages/OnboardingPage.tsx',
  'pages/PaymentRedirectPages.tsx',
];

/**
 * Surfaces rendering hundredths the app itself wrote. `FundingHistory` is the
 * pair that proves it: the same component's `toCents` multiplies by 100 with no
 * reference to the currency, so its reader must divide by 100 the same way.
 */
const HUNDREDTHS = ['components/FundingHistory.tsx', 'pages/SensitivityPage.tsx'];

const uses = (name: string) => (t: string) => new RegExp(`\\b${name}\\(`).test(t);

describe('a minor-unit integer is rendered by the rule that wrote it', () => {
  it('is looking at a source tree', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('renders processor amounts only through formatChargedCents', () => {
    const wrong = FILES.filter(({ file, text }) => CHARGED.includes(file) && uses('formatCents')(text));
    expect(wrong.map(({ file }) => file)).toEqual([]);
  });

  it('renders app-written hundredths only through formatCents', () => {
    const wrong = FILES.filter(
      ({ file, text }) => HUNDREDTHS.includes(file) && uses('formatChargedCents')(text),
    );
    expect(wrong.map(({ file }) => file)).toEqual([]);
  });

  it('has every caller of either formatter registered', () => {
    // A sixth billing page, or a new valuation surface, has to say which family
    // it is in — the two formatters cannot be told apart by their arguments.
    const callers = FILES.filter(
      ({ text }) => uses('formatCents')(text) || uses('formatChargedCents')(text),
    ).map(({ file }) => file);
    expect(callers.sort()).toEqual([...CHARGED, ...HUNDREDTHS].sort());
  });

  it('keeps FundingHistory reading what FundingHistory writes', () => {
    // The write side is the reason its family is what it is. If `toCents` ever
    // learns about the currency, this file moves to the other list.
    const text = FILES.find((f) => f.file === 'components/FundingHistory.tsx')?.text ?? '';
    expect(text).toContain('Math.round(Number(dollars) * 100)');
  });
});
