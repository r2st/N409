import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VALUATION_KINDS, type ValuationKind } from '../../src/domain/valuation.js';
import { problemCalls } from './errorBodyDisclosure.test.js';
import { KIND_LABELS, kindLabel } from '../../src/domain/valuationSelector.js';

/**
 * The words a person is shown for a valuation *kind*, on both sides of the wire
 * (round 262).
 *
 * Round 255 did this for `valuations.state` and stopped there. `kind` is the
 * other column this API names to a reader, and five refusals interpolated it
 * raw: "A ppa valuation is not measured in the terms this bridge explains",
 * "Run a 718 calculation before running this agent", and — the same shape as
 * R255's worst case — a refusal that helpfully listed the kinds the specialty
 * pipeline serves as nine more column values.
 *
 * What makes it a bug rather than a nit is that the estate already disagreed
 * with itself: `compare.ts` and `rollforward.ts` refuse the identical class of
 * request ("this kind is not measured in those terms") through `kindLabel`, so
 * the analyst was told "A Fund portfolio valuation and an IRC 409A valuation
 * measure different things" on one screen and "A fund valuation is not
 * measured…" on the next.
 *
 * Unlike `STATE_LABELS`, the browser's `KIND_LABELS` and the service's are
 * *deliberately* different registers — the browser's are badge-sized ("IRC
 * §409A"), the service's are the picker's full names ("IRC 409A valuation") —
 * so this pins coverage rather than equality. What may not drift is a kind
 * existing in the enum and being labelled nowhere, because `kindLabel` echoes
 * an unknown key and that is exactly how a raw column value gets back into a
 * sentence.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.resolve(HERE, '../..');
const ROUTES = path.resolve(SERVICE, 'src/routes');
const FORMAT = path.resolve(SERVICE, '../web-frontend/src/lib/format.ts');

/** The browser's `KIND_LABELS` object literal, read as text. */
function browserKindLabels(): Record<string, string> {
  const source = readFileSync(FORMAT, 'utf8');
  const start = source.indexOf('export const KIND_LABELS');
  expect(start, 'KIND_LABELS in web-frontend/src/lib/format.ts').toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  const close = source.indexOf('};', open);
  const out: Record<string, string> = {};
  for (const m of source.slice(open + 1, close).matchAll(/'?([\w§]+)'?:\s*'((?:[^\\']|\\.)*)'/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(full) && !/\.test\./.test(full) ? [full] : [];
  });
}

const routeSources = sourceFiles(ROUTES).map((file) => ({
  rel: path.relative(SERVICE, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

describe('valuation kind labels', () => {
  it('covers every kind, by type rather than by list', () => {
    // `Record<ValuationKind, string>` behind `KIND_LABELS` is the real guard —
    // a sixteenth kind will not compile until it is named. This checks the
    // census itself still has a population.
    expect(KIND_LABELS.map(([k]) => k).sort()).toEqual([...VALUATION_KINDS].sort());
  });

  it('is a label for every kind in the browser too', () => {
    // Not equality: the two registers differ on purpose (see the header). What
    // must hold is that neither side has a kind it cannot name.
    const browser = browserKindLabels();
    expect(Object.keys(browser).sort()).toEqual([...VALUATION_KINDS].sort());
  });

  it('never answers with the column value', () => {
    const identical = VALUATION_KINDS.filter((k: ValuationKind) => kindLabel(k) === k);
    expect(identical, 'kinds labelled with their own column value').toEqual([]);
  });
});

describe('the refusals that used to name the column', () => {
  it('finds the call sites it is auditing', () => {
    // A census that matches nothing passes every assertion below.
    const calls = routeSources.flatMap(({ text }) => problemCalls(text));
    expect(calls.length).toBeGreaterThan(250);
    expect(routeSources.some(({ text }) => text.includes('kindLabel('))).toBe(true);
  });

  it('interpolates no bare kind into a problem detail', () => {
    /*
     * Keyed on the interpolation rather than on the five strings that happened
     * to be wrong, because the failure mode is the sixth. `${valuation.kind}`,
     * `${unbridgeable.kind}`, a bare `${kind}` — any of them inside a
     * `problems.…()` argument is the column value on its way to a reader.
     *
     * `partnerApi.ts` is exempt: its published contract *is* the enum
     * (`kind: z.enum(VALUATION_KINDS)` in `partnerApiContract.ts`), the caller
     * is a program that sent one of those keys, and a refusal naming a value
     * the client itself supplied is the clearer answer there.
     */
    const findings: string[] = [];
    for (const { rel, text } of routeSources) {
      if (rel.endsWith('routes/partnerApi.ts')) continue;
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const { message } of problemCalls(stripped)) {
        for (const bare of message.matchAll(/\$\{\s*(?!kindLabel)([\w.]*\bkind\b[\w.]*)\s*\}/g)) {
          findings.push(`${rel} → \${${bare[1]!}}`);
        }
      }
    }
    expect(findings, 'refusals naming a valuation kind by its column value').toEqual([]);
  });

  it('lists the specialty kinds by name rather than by key', () => {
    const text = routeSources.find(({ rel }) => rel.endsWith('routes/specialty.ts'))!.text;
    expect(text).toContain('SPECIALTY_KINDS.map(kindLabel)');
    expect(text).not.toContain("SPECIALTY_KINDS.join(', ')");
  });
});
