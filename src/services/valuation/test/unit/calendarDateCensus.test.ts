import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isIsoCalendarDate } from '@n409/shared';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * `/^\d{4}-\d{2}-\d{2}$/` is a shape, and it keeps being used as a validity check.
 *
 * The shape admits `2026-02-31`, `2026-13-01`, `2026-00-10` and `2026-02-29` in
 * a common year. None of those is a day, and what happens to one depends only
 * on where it lands — which is why the class produces such different-looking
 * bugs that nobody connects them:
 *
 *   * into a `date` column, Postgres raises `date/time field value out of
 *     range`, so a validation gap surfaces as a 500 — or, in the HRIS import,
 *     as an uncaught throw inside an insert loop that ended a connection's
 *     syncs for good;
 *   * into `new Date(...)`, JavaScript rolls it forward without a word, so the
 *     value is simply wrong from then on: a volatility window whose two ends
 *     disagree by three days, a date printed onto a statutory HMRC return.
 *
 * `isIsoCalendarDate` (`@n409/shared`) is the answer and has been since it was
 * written; the routes all pair it with the shape. The gaps were the paths whose
 * dates arrive from somewhere other than a form — a provider's payload, a
 * stored engine-inputs document — which is exactly where a shape check is worth
 * least.
 *
 * A behavioural test closes one site. This closes the class, the same way
 * `todayLocalSweep` closes the UTC-day one: by making the *next* author's
 * shape-only check fail here rather than in production.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const REPO = path.resolve(HERE, '../..');

/**
 * The literal, anchored end to end.
 *
 * Anchored so it cannot match the timestamp patterns that legitimately begin
 * the same way — `domain/pagination.ts`'s `CURSOR_AT_RE` is
 * `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/`, which is a cursor
 * position and not a calendar day at all.
 */
const DATE_SHAPE = /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//;

/**
 * Comments are stripped before scanning.
 *
 * This file, and several of the files it polices, name the pattern in their own
 * prose to explain why it is not enough — including the docstring above. A scan
 * that read prose would either fail on its own explanation or force every
 * explanation to be written around it, and an unexplained guard is the one that
 * gets deleted.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * A shape check is fine when the file also reaches for the calendar — that is
 * the `.regex(...).refine(isIsoCalendarDate, ...)` pairing every date-taking
 * route uses, where the regex supplies the message and the refine supplies the
 * rule.
 */
const offenders = sourceFiles(SRC)
  .map((file) => ({ file, source: code(readFileSync(file, 'utf8')) }))
  .filter(({ source }) => DATE_SHAPE.test(source) && !source.includes('isIsoCalendarDate'))
  .map(({ file }) => path.relative(REPO, file));

describe('the ISO date shape is not a calendar check', () => {
  it('is never the only check on a date anywhere in src', () => {
    expect(offenders).toEqual([]);
  });

  it('matches the literal as it is actually written', () => {
    // The scan is worth exactly what its pattern matches, so the pattern is
    // asserted rather than trusted.
    expect(DATE_SHAPE.test(String.raw`return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;`)).toBe(true);
    expect(DATE_SHAPE.test(String.raw`.regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')`)).toBe(true);
  });

  it('leaves a timestamp pattern alone', () => {
    // `CURSOR_AT_RE` opens with the same nine tokens and is not a day.
    expect(DATE_SHAPE.test(String.raw`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/`)).toBe(false);
  });

  it('strips prose so a guard may explain itself', () => {
    const explained = [
      '/**',
      String.raw` * /^\d{4}-\d{2}-\d{2}$/ is a shape, not a rule.`,
      ' */',
      'const ok = someOtherCheck(day);',
    ].join('\n');
    expect(DATE_SHAPE.test(code(explained))).toBe(false);
    expect(DATE_SHAPE.test(code(String.raw`const d = /^\d{4}-\d{2}-\d{2}$/; // a real one`))).toBe(true);
  });
});

/**
 * The rule the scan is standing in for, stated once so the scan's premise is
 * not itself taken on trust.
 */
describe('the days the shape admits and the calendar does not', () => {
  it('rejects each of them', () => {
    for (const day of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '2026-02-29']) {
      expect(/^\d{4}-\d{2}-\d{2}$/.test(day), day).toBe(true);
      expect(isIsoCalendarDate(day), day).toBe(false);
    }
  });
});
