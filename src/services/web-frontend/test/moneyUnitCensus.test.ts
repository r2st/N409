/**
 * A money formatter's unit contract is checked at the call site, not the import
 * line.
 *
 * R127's hundredfold was not a wrong call — it was a wrong *import*. Two
 * modules exported `formatMoney`, one dividing by 100 and one not, and
 * `GrantsTab` and `Asc718Tab` picked the dividing one for figures that were
 * never in cents. Every call site read `formatMoney(g.exercise_price)` and
 * looked right; the only place the mistake was visible was a line at the top of
 * the file nobody re-reads. Renaming the dividing one to `formatCents` made
 * that call site visibly wrong, but a rename is a convention, not a check: the
 * next component to reach for the wrong formatter would still typecheck, still
 * render, and still be off by a factor of a hundred.
 *
 * So the rule is stated once, here, over the whole source tree:
 *
 *   - a formatter that DIVIDES by 100 may only be handed an expression that
 *     says it holds minor units — a `*_cents` field, a `*Cents` local, a
 *     `*_CENTS` constant — or a numeric literal, which is reviewable where it
 *     is written;
 *   - a formatter that does NOT divide may not be handed one, unless the call
 *     site divides by 100 itself.
 *
 * Imports are resolved rather than matched by name, because the name is exactly
 * what was ambiguous: an alias (`formatCents as fmt`) or a fifth formatter
 * would slip a name-based census, and the completeness test below is what stops
 * a new formatter being added without a unit.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

type Unit = 'minor' | 'major';

/**
 * Every money formatter the frontend has, and what unit it takes. `minor`
 * means the function divides by 100 on the caller's behalf.
 *
 * Keyed by module basename because that is what an import specifier ends with,
 * whatever depth the importing file sits at.
 */
const FORMATTERS: Record<string, Record<string, Unit>> = {
  format: { formatCents: 'minor', formatAmount: 'major' },
  pipeline: { formatMoney: 'major' },
  marketing: { formatUsd: 'minor' },
};

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
 * The named specifiers a file imports from a formatter module, mapped from the
 * local name it will call them by to the unit that name now takes. `import {
 * formatCents as fmt }` binds `fmt` to `minor`.
 */
export function importedFormatters(text: string): Map<string, Unit> {
  const bound = new Map<string, Unit>();
  const importRe = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(text))) {
    const table = FORMATTERS[match[2]!.split('/').pop()!];
    if (!table) continue;
    for (const specifier of match[1]!.split(',')) {
      const spec = specifier.trim().replace(/^type\s+/, '');
      if (!spec) continue;
      const [original, alias] = spec.split(/\s+as\s+/).map((part) => part.trim());
      const unit = table[original!];
      if (unit) bound.set(alias ?? original!, unit);
    }
  }
  return bound;
}

/**
 * The first argument of each `name(...)` call, as written. Brackets are
 * balanced so a nested call (`formatMoney(Number(g.exercise_price), c)`) is
 * kept whole and the currency argument is not mistaken for the amount.
 */
export function firstArguments(text: string, name: string): { arg: string; line: number }[] {
  const found: { arg: string; line: number }[] = [];
  const callRe = new RegExp(`\\b${name}\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(text))) {
    let i = match.index + match[0].length;
    let depth = 1;
    let arg = '';
    while (i < text.length) {
      const c = text[i]!;
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) break;
      } else if (c === ',' && depth === 1) break;
      arg += c;
      i++;
    }
    found.push({
      arg: arg.trim().replace(/\s+/g, ' '),
      line: text.slice(0, match.index).split('\n').length,
    });
  }
  return found;
}

const saysMinor = (arg: string) => /cents/i.test(arg);
const dividesItself = (arg: string) => /\/\s*100\b/.test(arg);
const isNumericLiteral = (arg: string) => /^-?[\d_]+(\.\d+)?$/.test(arg);

/** Call sites whose argument disagrees with the formatter's unit. */
export function unitViolations(file: string, text: string): string[] {
  const offences: string[] = [];
  for (const [name, unit] of importedFormatters(text)) {
    for (const { arg, line } of firstArguments(text, name)) {
      if (unit === 'minor' && !saysMinor(arg) && !isNumericLiteral(arg)) {
        offences.push(`${file}:${line} ${name}(${arg}) — divides by 100, argument does not say cents`);
      }
      if (unit === 'major' && saysMinor(arg) && !dividesItself(arg)) {
        offences.push(`${file}:${line} ${name}(${arg}) — takes major units, argument is cents`);
      }
    }
  }
  return offences;
}

describe('money formatters are handed the unit they take', () => {
  it('is looking at a source tree', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('has every money formatter in the units table', () => {
    // The completeness half. A census keyed on a hand-written list of names is
    // only as good as the list, and the failure this whole file exists for was
    // a *second* formatter appearing under a name that already meant something
    // else. Any new export shaped like a money formatter has to declare a unit
    // before it can be imported anywhere.
    const declared = new Set(Object.values(FORMATTERS).flatMap((m) => Object.keys(m)));
    const shaped = /export function (format[A-Za-z]*(?:Money|Cents|Amount|Usd|Currency|Price))\b/g;
    const missing: string[] = [];
    for (const { file, text } of FILES) {
      if (!/^lib\//.test(file)) continue;
      let match: RegExpExecArray | null;
      while ((match = shaped.exec(text))) {
        if (!declared.has(match[1]!)) missing.push(`${file} exports ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('has no call site disagreeing with its formatter', () => {
    const offences = FILES.flatMap(({ file, text }) => unitViolations(file, text));
    expect(offences).toEqual([]);
  });

  it('would catch the call site R127 had to fix', () => {
    // The vacuity guard. A census over a tree that no longer contains the
    // idiom passes whether or not it works, so it is asked directly about the
    // shape GrantsTab and Asc718Tab were written in — the same argument, now
    // reaching the dividing formatter under the name that admits it divides.
    const grantsTabBefore = [
      "import { formatCents } from '../../lib/format';",
      'const cell = formatCents(g.exercise_price, g.currency);',
    ].join('\n');
    expect(unitViolations('GrantsTab.tsx', grantsTabBefore)).toHaveLength(1);

    // Same call, the formatter that does not divide: nothing to say.
    const grantsTabAfter = [
      "import { formatMoney } from '../../lib/pipeline';",
      'const cell = formatMoney(g.exercise_price, g.currency);',
    ].join('\n');
    expect(unitViolations('GrantsTab.tsx', grantsTabAfter)).toEqual([]);

    // And the other direction — cents through a formatter that does not divide.
    const backwards = [
      "import { formatAmount } from '../lib/format';",
      'const cell = formatAmount(row.amount_raised_cents);',
    ].join('\n');
    expect(unitViolations('X.tsx', backwards)).toHaveLength(1);
  });

  it('lets the import decide, not the name', () => {
    // R127 in one pair. Two files, one identifier, identical call text, and
    // the verdict comes from the module the name was bound to — which is the
    // only thing that differed between the broken GrantsTab and a correct one.
    const call = 'const cell = money(g.exercise_price, g.currency);';
    const dividing = ["import { formatCents as money } from '../lib/format';", call].join('\n');
    const notDividing = ["import { formatMoney as money } from '../lib/pipeline';", call].join('\n');
    expect(unitViolations('A.tsx', dividing)).toHaveLength(1);
    expect(unitViolations('B.tsx', notDividing)).toEqual([]);
  });

  it('reads a nested call, an explicit divide and a literal', () => {
    // The currency argument is not the amount: a nested call must stay whole.
    const nested = [
      "import { formatMoney } from '../../lib/pipeline';",
      'const cell = formatMoney(Number(g.exercise_price), g.currency);',
    ].join('\n');
    expect(unitViolations('X.tsx', nested)).toEqual([]);

    // A call site that does the division itself is stating its unit too.
    const divided = [
      "import { formatMoney } from '../../lib/pipeline';",
      'const cell = formatMoney(r.amount_raised_cents / 100, currency);',
    ].join('\n');
    expect(unitViolations('X.tsx', divided)).toEqual([]);

    // A literal is reviewable where it is written.
    const literal = [
      "import { formatUsd } from '../../lib/marketing';",
      'const cell = formatUsd(99_000);',
    ].join('\n');
    expect(unitViolations('X.tsx', literal)).toEqual([]);
  });
});
