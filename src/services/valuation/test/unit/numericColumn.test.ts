import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEBT_FAIR_VALUE,
  FUND_MARK_FAIR_VALUE,
  PROJECTION_TERMINAL_VALUE,
  ROLLFORWARD_EQUITY_VALUE,
  fitsNumeric,
  numericCeiling,
  requireStorableFigure,
} from '../../src/domain/numericColumn.js';

describe('numeric column capacity', () => {
  it('reads the ceiling off the column declaration', () => {
    // numeric(24, 4) leaves 20 digits left of the point.
    expect(numericCeiling(FUND_MARK_FAIR_VALUE)).toBe(1e20);
    expect(numericCeiling(DEBT_FAIR_VALUE)).toBe(1e18);
  });

  it('admits what the column holds and refuses what it does not', () => {
    expect(fitsNumeric(0, FUND_MARK_FAIR_VALUE)).toBe(true);
    expect(fitsNumeric(-1e19, FUND_MARK_FAIR_VALUE)).toBe(true);
    expect(fitsNumeric(1e20, FUND_MARK_FAIR_VALUE)).toBe(false);
    expect(fitsNumeric(-1e20, FUND_MARK_FAIR_VALUE)).toBe(false);
    // The product the fund routes could previously produce.
    expect(fitsNumeric(1e15 * 1e12, FUND_MARK_FAIR_VALUE)).toBe(false);
  });

  it('refuses a non-finite figure too', () => {
    expect(fitsNumeric(Number.POSITIVE_INFINITY, DEBT_FAIR_VALUE)).toBe(false);
    expect(fitsNumeric(Number.NaN, DEBT_FAIR_VALUE)).toBe(false);
  });

  it('passes a storable figure straight through', () => {
    expect(requireStorableFigure(1234.5, 'Fair value', DEBT_FAIR_VALUE)).toBe(1234.5);
  });

  it('leaves a null figure alone — not every run produces one', () => {
    expect(requireStorableFigure(null, 'Fair value', DEBT_FAIR_VALUE)).toBeNull();
  });

  it('names the figure and the ceiling when it will not fit', () => {
    try {
      requireStorableFigure(1e27, 'Fair value', FUND_MARK_FAIR_VALUE);
      expect.unreachable('should have thrown');
    } catch (err) {
      const problem = err as { statusCode?: number; status?: number; detail?: string; message?: string };
      expect(problem.statusCode ?? problem.status).toBe(422);
      const text = problem.detail ?? problem.message ?? '';
      expect(text).toMatch(/1\.000e\+27/);
      expect(text).toMatch(/1e\+20/);
      expect(text).toMatch(/Fair value/);
    }
  });
});

/**
 * The roll-forward and the projection were the two engine-computed figures on a
 * `numeric` column that this rule had never been applied to. Both are the shape
 * the module's own note describes — a product (or a quotient) of parts that are
 * each individually inside their bound — and both reached the driver as a
 * `22003 numeric field overflow`, which is a 500 naming nothing.
 */
describe('the columns the roll-forward and the projection write', () => {
  it('reads the ceiling off numeric(20, 2)', () => {
    expect(numericCeiling(ROLLFORWARD_EQUITY_VALUE)).toBe(1e18);
    expect(numericCeiling(PROJECTION_TERMINAL_VALUE)).toBe(1e18);
  });

  it('refuses the compounded value an eleven-year gap at the rate cap produces', () => {
    // `RunBody` caps `annual_accretion` at 10 (1000% a year) and the gap is two
    // analyst-entered dates apart. Finite and positive, so both the engine and
    // `shapeRollforward` pass it.
    const rolled = 1e7 * 11 ** 11;
    expect(Number.isFinite(rolled)).toBe(true);
    expect(fitsNumeric(rolled, ROLLFORWARD_EQUITY_VALUE)).toBe(false);
    expect(() =>
      requireStorableFigure(rolled, 'Rolled-forward equity value', ROLLFORWARD_EQUITY_VALUE),
    ).toThrow(/Rolled-forward equity value/);
  });

  it('refuses a Gordon terminal value struck off a spread that is nearly zero', () => {
    // FCF x (1 + g) / (r - g) with r and g a thousandth apart.
    const terminal = (1e9 * 1.02) / 1e-9;
    expect(Number.isFinite(terminal)).toBe(true);
    expect(fitsNumeric(terminal, PROJECTION_TERMINAL_VALUE)).toBe(false);
    expect(() => requireStorableFigure(terminal, 'Terminal value', PROJECTION_TERMINAL_VALUE)).toThrow(
      /Terminal value/,
    );
  });

  it('still admits the figures these runs actually produce', () => {
    expect(requireStorableFigure(4.2e7, 'Prior equity value', ROLLFORWARD_EQUITY_VALUE)).toBe(4.2e7);
    // A projection with no terminal method stores none, and null is not a refusal.
    expect(requireStorableFigure(null, 'Terminal value', PROJECTION_TERMINAL_VALUE)).toBeNull();
  });
});

/**
 * Census: a declared column with no guard behind it.
 *
 * The rule this module states is only worth anything where it is applied, and
 * the way it stopped being applied was that two later subsystems stored an
 * engine figure without knowing the rule existed. Declaring a column here and
 * then not checking against it is the same omission wearing the rule's name, so
 * every export below has to be cited by a `requireStorableFigure` call site.
 */
describe('every declared column is guarded somewhere', () => {
  const srcRoot = new URL('../../src/', import.meta.url).pathname;

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  it('cites each NumericColumn from a requireStorableFigure call', () => {
    const declaration = readFileSync(join(srcRoot, 'domain/numericColumn.ts'), 'utf8');
    const declared = [...declaration.matchAll(/export const ([A-Z0-9_]+): NumericColumn/g)].map(
      (m) => m[1]!,
    );
    expect(declared.length).toBeGreaterThan(0);

    const callSites = sources(srcRoot)
      .filter((f) => !f.endsWith('domain/numericColumn.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .filter((text) => text.includes('requireStorableFigure'))
      .join('\n');

    const unguarded = declared.filter((name) => !callSites.includes(name));
    expect(unguarded).toEqual([]);
  });
});
