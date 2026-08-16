import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * `new Date().toISOString().slice(0, 10)` is not today, and it keeps coming back.
 *
 * The expression has now been removed from this repository three times. R80
 * took it out of eleven production call sites in favour of `todayLocal()`; R82
 * found the same reading surviving in four *tests*, which held the UTC day as
 * their expectation and compared it against a route that had correctly dated
 * itself locally; R84 fixed those four. Each round removed the instances that
 * existed and left nothing standing between the next author and the fourth.
 *
 * It recurs because it is the obvious way to write it and because it is right
 * for twenty hours a day. On a UTC CI box it is right for all twenty-four,
 * which is why none of the three rounds were caught by a green suite — the
 * failure needs both a non-zero offset and the hours between the two days'
 * rollovers, and the only reason R82's four surfaced at all is that someone
 * happened to run the suite after 8pm in New York.
 *
 * A behavioural test cannot close that, for the same reason: the four
 * integration assertions this file accompanies are exact in the evening and
 * vacuous in the morning. A source scan is exact at every hour in every zone,
 * so this is the guard that actually holds the class shut. Same shape as
 * `finiteNumberSweep` and `sqlInterpolationSweep`.
 *
 * ## What is and is not the mistake
 *
 * Only the **clock** reading matters — `new Date()` with no argument, formatted
 * through UTC. `someDate.toISOString().slice(0, 10)` on a value that already
 * exists is a different question with a different answer, and several tests
 * near these use it deliberately to state the premise they are about (that a
 * driver Date for 30 June reads as the 29th east of UTC). Those stay. The scan
 * is written to the literal clock expression so it cannot confuse the two.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const TEST = path.resolve(HERE, '..');

/** The clock, read as a UTC calendar day. Whitespace-tolerant, nothing else. */
const CLOCK_IN_UTC = /new Date\(\)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/;

/**
 * The three files allowed to hold it, each because it is *about* the reading
 * rather than reaching for it.
 *
 *   * `routes/monitoring.ts` keeps the UTC day at one last fallback, on purpose
 *     and with eight lines of comment saying why: it is reached only when an
 *     engagement has no resolution, no publication and no completion, so there
 *     is no day to be right about, and it sits between two deliberate
 *     UTC-instant readings feeding a twelve-month window.
 *   * `monitoringRefusals` asserts exactly that choice, so it has to write it.
 *   * `todayLocal.test.ts` asserts the two readings *disagree*, under forced
 *     zones and fake timers. The UTC day is half of what it is comparing.
 *
 * Paths, not basenames: a new file called `monitoring.ts` elsewhere should fail
 * here rather than inherit an exemption granted to a different one.
 */
const ALLOWED = new Set([
  path.join(SRC, 'routes', 'monitoring.ts'),
  path.join(TEST, 'integration', 'monitoringRefusals.test.ts'),
  path.join(TEST, 'unit', 'todayLocal.test.ts'),
  // This file names the expression in its own prose and pattern.
  path.join(TEST, 'unit', 'todayLocalSweep.test.ts'),
]);

const offenders = (dir: string): string[] =>
  sourceFiles(dir)
    .filter((file) => !ALLOWED.has(file))
    .filter((file) => CLOCK_IN_UTC.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(path.resolve(HERE, '../..'), file));

describe('the UTC day is not today', () => {
  it('is not read from the clock anywhere in src', () => {
    // `todayLocal()` from `domain/calendarDate.js` is the replacement, and it
    // takes an optional instant so a test can pass the moment under test.
    expect(offenders(SRC)).toEqual([]);
  });

  it('is not held as an expectation anywhere in the suite', () => {
    // The R82 shape. A test that mints its own UTC "today" and compares it
    // against a locally-dated route passes until 20:00 and fails after — the
    // worst kind of red, because it arrives hours after the change that is
    // blamed for it. `test/support/today.ts` is what these should use.
    expect(offenders(TEST)).toEqual([]);
  });

  it('catches the expression in every spacing a formatter might produce', () => {
    // The scan is only worth what its pattern matches, so the pattern is
    // asserted rather than trusted.
    for (const form of [
      'new Date().toISOString().slice(0, 10)',
      'new Date().toISOString().slice(0,10)',
      'new Date()\n      .toISOString()\n      .slice(0, 10)',
    ]) {
      expect(CLOCK_IN_UTC.test(form)).toBe(true);
    }
  });

  it('leaves a fixed Date formatted through UTC alone', () => {
    // The neighbouring case that must keep working: a Date that already exists,
    // or one built in UTC on purpose, is not the clock and is not this bug.
    for (const form of [
      'pgDate(2026, 6, 30).toISOString().slice(0, 10)',
      'new Date(2029, 5, 30).toISOString().slice(0, 10)',
      'new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10)',
    ]) {
      expect(CLOCK_IN_UTC.test(form)).toBe(false);
    }
  });
});

/**
 * The four defaults the integration tests exercise, pinned at the source.
 *
 * Those tests prove the behaviour and are the better guard when they can see
 * it; this proves the *reach* — which function each route asked for the day —
 * and it can see that at 9am as well as 9pm. Between them a revert fails
 * whatever the hour.
 */
describe('the routes that mint a date default', () => {
  const routes = [
    ['debt.ts', 'a debt valuation dated into a day that has not happened'],
    ['funds.ts', 'a fund mark measured into the future'],
    ['asc718.ts', 'a volatility window closing on a day with no close'],
    ['reports.ts', "a 409A report stating tomorrow's date"],
    ['boardApproval.ts', 'a board resolution dated after the meeting that passed it'],
  ] as const;

  for (const [file, consequence] of routes) {
    it(`${file} defaults through todayLocal — otherwise ${consequence}`, () => {
      const source = readFileSync(path.join(SRC, 'routes', file), 'utf8');
      expect(source).toContain('todayLocal');
      expect(CLOCK_IN_UTC.test(source)).toBe(false);
    });
  }
});
