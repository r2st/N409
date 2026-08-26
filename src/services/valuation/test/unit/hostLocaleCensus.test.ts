import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runHealthChecks } from '../../src/domain/healthChecks.js';
import { evaluateTriggers, type MonitorSnapshot } from '../../src/domain/monitoring.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * A number formatted with no locale is formatted in the *host's*.
 *
 * `n.toLocaleString()` and a bare `new Intl.NumberFormat()` both resolve
 * against the locale the process picked up at startup, which ICU reads from
 * `LC_ALL` / `LC_NUMERIC` / `LANG`. In a browser that is exactly right — it is
 * the reader's own locale. On a server it is not the reader's anything: it is
 * whatever the unit file, the base image or the operator's shell happened to
 * export, and the reader is somebody else entirely, holding a document the
 * server wrote.
 *
 * Seven readings in this service formatted that way, and the two families they
 * sat in are the two that travel furthest:
 *
 *   * `domain/healthChecks.ts` — the detail line under each finding, shown in
 *     the workspace and carried into the review record;
 *   * `domain/monitoring.ts` — a trigger's `message`, which the alerting job
 *     quotes verbatim into the email that reaches the assigned reviewer.
 *
 * The failure is not cosmetic. Under any comma-decimal locale — `de_DE`,
 * `fr_FR`, `es_ES`, `pt_BR`, most of the ones a European operator's laptop or
 * a localised base image would set — a group separator becomes a decimal
 * point, so "8,000,000 common shares" is mailed as "8.000.000 common shares"
 * and a cap-table move of +1,500 is mailed as +1.500. Nothing marks it as a
 * formatting artefact; it reads as a smaller number, correctly punctuated.
 *
 * This is the same shape as `todayLocalSweep`: an environment variable nobody
 * in the deployment thinks of as configuration deciding what a document says.
 * It is latent on the current box, which sets no `LANG` at all, and latent is
 * the state it stays in only until somebody sets one — which is why the guard
 * is a source scan and not a behavioural assertion that a UTF-8-less CI box
 * would pass for the wrong reason.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The `src/` tree: this file sits at `src/services/valuation/test/unit`. */
const SRC = path.resolve(HERE, '../../../..');

/**
 * The server trees only. `services/web-frontend` is deliberately absent: code
 * that runs in the reader's browser *should* format in the reader's locale,
 * and it does so in eight places on purpose.
 */
const ROOTS = ['services/valuation/src', 'services/web/src', 'services/report/src', 'packages'];

const isBuildOutput = (file: string): boolean => file.split(path.sep).includes('dist');

/**
 * `x.toLocaleString()`, `d.toLocaleDateString()`, `new Intl.NumberFormat()`
 * and `new Intl.NumberFormat({ … })` — every spelling that omits the locale
 * argument. An options object with no locale before it is the same mistake as
 * no argument at all, and is the easier one to write without noticing.
 */
const IMPLICIT_LOCALE = /\.toLocale(?:String|DateString|TimeString)\(\s*\)|new Intl\.[A-Za-z]+\(\s*(?:\)|\{)/;

/**
 * Comment lines are skipped, because this file's subject has to be discussed
 * where it was fixed — `healthChecks.ts` and `monitoring.ts` each carry a note
 * naming the spelling they no longer use. The vacuity guard below is what
 * stops the skip from quietly swallowing the scan.
 */
const isProse = (line: string): boolean => /^(\/\/|\/\*|\*)/.test(line.trim());

interface Hit {
  file: string;
  line: number;
  text: string;
}

function implicitLocaleFormatting(): Hit[] {
  const hits: Hit[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(SRC, root))) {
      if (isBuildOutput(file)) continue;
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (isProse(line)) return;
          if (IMPLICIT_LOCALE.test(line)) hits.push({ file: rel, line: i + 1, text: line.trim() });
        });
    }
  }
  return hits;
}

describe('a number the server formats for somebody else to read', () => {
  it('scans every tree it claims to', () => {
    for (const root of ROOTS) expect(existsSync(path.join(SRC, root)), root).toBe(true);
  });

  it('names an explicit locale everywhere in the server trees', () => {
    // `new Intl.NumberFormat('en-US')` — the spelling the other twelve
    // formatters in this service already use — is the replacement.
    expect(implicitLocaleFormatting()).toEqual([]);
  });

  it('catches every spelling that omits the locale', () => {
    // The vacuity guard. The assertion above passes for a scan that finds
    // nothing, including one whose pattern has stopped matching anything, so
    // the pattern is asserted rather than trusted.
    for (const form of [
      'return value.toLocaleString();',
      '`${n.toLocaleString()} shares`',
      'd.toLocaleDateString()',
      'd.toLocaleTimeString()',
      'const INT = new Intl.NumberFormat();',
      'new Intl.NumberFormat({ maximumFractionDigits: 2 })',
      'new Intl.DateTimeFormat({ timeZone: tz })',
    ]) {
      expect(IMPLICIT_LOCALE.test(form), form).toBe(true);
    }
  });

  it('leaves an explicitly located formatter alone', () => {
    for (const form of [
      "new Intl.NumberFormat('en-US')",
      "new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })",
      "new Intl.DateTimeFormat('en-US', { timeZone: tz })",
      "value.toLocaleString('en-US')",
      "MAX_GRID_CELLS.toLocaleString('en-US')",
      'new Intl.NumberFormat(locale, opts)',
    ]) {
      expect(IMPLICIT_LOCALE.test(form), form).toBe(false);
    }
  });
});

/**
 * The behavioural half: run the two families with the host's default locale
 * standing in for a comma-decimal one, and read the prose that comes out.
 *
 * `Number.prototype.toLocaleString` is patched rather than the environment,
 * because ICU resolves the default locale once at process start and no test
 * can move it afterwards. Patching the prototype reproduces exactly what a
 * `LANG=de_DE.UTF-8` box does to a *bare* call and leaves a located one
 * untouched, so these assertions fail if and only if a reading omitted its
 * locale.
 */
function withHostLocale<T>(locale: string, fn: () => T): T {
  const original = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (
    this: number,
    locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions,
  ): string {
    return original.call(this, locales ?? locale, options);
  };
  try {
    return fn();
  } finally {
    Number.prototype.toLocaleString = original;
  }
}

/** Whether this Node has the data to tell the two apart at all. */
const ICU_HAS_DE = (1_234_567).toLocaleString('de-DE') === '1.234.567';

function healthy() {
  return {
    calculation: {
      inputs: {
        params: {
          weight_opm: 1,
          dlom: 0.2,
          dlom_method: 'finnerty',
          allocation_method: 'opm',
        },
        inputs: {
          valuation_date: '2026-06-30',
          shares_outstanding_common: 8_000_000,
          options_outstanding: 1_000_000,
          volatility: 0.6,
          share_classes: [
            { kind: 'common', name: 'Common', shares: 8_000_000 },
            { kind: 'preferred', name: 'A', shares: 2_000_000, preference: 5e6 },
          ],
        },
      },
      results: { fully_diluted_common: 9_000_000 },
      equity_value: 20_000_000,
      fmv_per_share: 1.5,
      created_at: '2026-07-01T00:00:00Z',
    },
    params: {
      weight_opm: 1,
      dlom: 0.2,
      dlom_method: 'finnerty',
      allocation_method: 'opm',
      fiscal_year_end: '2025-12-31',
      updated_at: '2026-06-30T00:00:00Z',
    },
    valuation: { currency: 'USD' },
  };
}

const detail = (report: ReturnType<typeof runHealthChecks>, key: string) =>
  report.checks.find((c) => c.key === key)?.detail ?? '';

describe.skipIf(!ICU_HAS_DE)('the prose a comma-decimal host produces', () => {
  it('states share counts the same way whatever LANG the box exports', () => {
    const here = runHealthChecks(healthy());
    const abroad = withHostLocale('de-DE', () => runHealthChecks(healthy()));

    // Every detail line, not just the ones known to quote a figure: a reading
    // added later is covered without this test being touched.
    expect(abroad.checks.map((c) => c.detail)).toEqual(here.checks.map((c) => c.detail));

    // And the figures themselves, so the equality above cannot be satisfied by
    // both sides being wrong in the same way.
    expect(detail(abroad, 'common_shares_present')).toBe('8,000,000 common shares');
    expect(detail(abroad, 'share_counts_match')).toContain('9,000,000');
    expect(detail(abroad, 'equity_positive')).toContain('20,000,000');
  });

  it('mails a cap-table move as the number it is', () => {
    const baseline: MonitorSnapshot = {
      valuation_date: '2026-01-01',
      fmv_per_share: 1.5,
      annual_revenue: 1_000_000,
      fully_diluted_shares: 10_000_000,
      last_round_date: '2025-06-01',
    };
    const current: MonitorSnapshot = {
      ...baseline,
      valuation_date: null,
      fully_diluted_shares: 10_001_500,
    };
    const now = new Date('2026-03-01T00:00:00Z');

    const message = (triggers: ReturnType<typeof evaluateTriggers>, type: string) =>
      triggers.find((t) => t.type === type)?.message ?? '';

    const abroad = withHostLocale('de-DE', () => evaluateTriggers(baseline, current, now));
    // "+1.500" is a fifteen-hundred-share move written as fifteen hundredths
    // of a share, and nothing in the sentence says which was meant.
    expect(message(abroad, 'cap_table_change')).toBe(
      'The cap table changed by +1,500 shares since the valuation.',
    );
    expect(message(abroad, 'cap_table_change')).toBe(
      message(evaluateTriggers(baseline, current, now), 'cap_table_change'),
    );
  });

  it('mails a first revenue figure as the number it is', () => {
    const baseline: MonitorSnapshot = {
      valuation_date: '2026-01-01',
      fmv_per_share: 1.5,
      annual_revenue: 0,
      fully_diluted_shares: 10_000_000,
      last_round_date: null,
    };
    const current: MonitorSnapshot = { ...baseline, valuation_date: null, annual_revenue: 1_250_000 };
    const abroad = withHostLocale('de-DE', () =>
      evaluateTriggers(baseline, current, new Date('2026-03-01T00:00:00Z')),
    );
    expect(abroad.find((t) => t.type === 'revenue_change')?.message).toContain('1,250,000 annualised');
  });

  it('reproduces the host it is standing in for', () => {
    // The premise. If patching the prototype did not change a bare reading,
    // every assertion above would pass for a reason that has nothing to do
    // with the fix.
    expect(withHostLocale('de-DE', () => (1_234_567).toLocaleString())).toBe('1.234.567');
    expect(withHostLocale('de-DE', () => (1_234_567).toLocaleString('en-US'))).toBe('1,234,567');
    expect(withHostLocale('de-DE', () => new Intl.NumberFormat('en-US').format(1_234_567))).toBe('1,234,567');
  });
});
