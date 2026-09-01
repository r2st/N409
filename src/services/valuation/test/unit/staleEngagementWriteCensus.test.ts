/**
 * A route that leaves the process and then writes, asked again on the way back.
 *
 * `refuseIfRetired` reads the engagement the request came in with, which is the
 * right reading for a handler whose write follows in the same millisecond and
 * the wrong one for a handler that spends an engine or an AI round trip in
 * between. `refuseIfRetiredNow` states why in as many words — "a run is exactly
 * the length of time in which a decision about a file gets made" — and
 * `refuseIfSubjectRetiredIn` says the same thing from the other side: "on `POST
 * /funds/:id/positions/:pid/marks` that gap was the whole engine round trip".
 *
 * The rule has been settled one route at a time. R232 closed the extraction
 * auto-apply, R236 the queued pipeline run, R2xx the report draft and the QA
 * review, R279 and R282 the measurement surface — and each time the fix was
 * written into the branch that had just been found rather than into anything
 * that would find the next one. R292 then found six more in one pass, including
 * `POST /valuations/:id/calculations`, whose stored row is the engagement's
 * concluded FMV per share.
 *
 * So this is the thing that finds them. For every `postJson` call in a route
 * file, it reads forward to the next write and fails if no re-ask stands
 * between the two. Derived from the source rather than listed, so a route added
 * next year is in the population the day it is written.
 *
 * WHAT IT DELIBERATELY DOES NOT ASK. Reads stay open everywhere — a firm that
 * has withdrawn work still has to be able to look at it — so a handler that
 * calls the engine and returns the answer without storing it (`/wacc/preview`,
 * `/sensitivity`, `/asc718`) has nothing here to answer for. And a *failure*
 * row written in a catch is the record of an attempt rather than a conclusion,
 * which is the distinction `ai.ts` draws when it settles a job whose effect it
 * then declines to apply; those are matched and skipped by the `status:
 * 'failed'` beside them.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(here, '../../src/routes');

/**
 * Repo writes that persist something against an engagement.
 *
 * `recordEvent` and `recordAdminEvent` are excluded by name. An audit row is
 * the record that something happened, and something did — refusing to write one
 * because the engagement was withdrawn a moment ago is losing the evidence, not
 * protecting the file. Every other `record*` is a content write and is in.
 */
const WRITE = /\bawait (create|insert|record|upsert|apply|replace|mark|patch|update)[A-Z]\w*\(/;
const AUDIT_WRITE = /\bawait record(Admin)?Event\(/;
/** The ways a handler re-asks the question after leaving the process. */
const REASK =
  /\b(refuseIfRetiredNow|refuseIfSubjectRetired|refuseIfSubjectRetiredIn|isRetiredNow|instrumentForWriteIn|positionForWriteIn)\(/;
/**
 * A call that leaves the process.
 *
 * The three connector pulls are here as of R308 (methodology M5). They are the
 * same gap through a different door and a *longer* one — `PAGED_PULL_BUDGET_MS`
 * allows a page walk two minutes, where an engine round trip is seconds — and
 * the census could not see them, because they do not go through `postJson`.
 * Nothing exempted them; they were simply outside the population, which is the
 * failure mode a census is supposed to remove rather than reproduce.
 */
const OUTBOUND = /\b(postJson|postForm|getJson|fetchCapTable|fetchRosterAndGrants|fetchFinancials)\b/;

/**
 * Writes that record an attempt rather than a conclusion. `createCalculation`
 * with `status: 'failed'` is the shape: the engine refused, and the row is the
 * evidence of that refusal. Turning it into a 409 would lose it.
 */
const ATTEMPT_RECORD = /status: 'failed'/;

/**
 * Writers whose whole subject is that an attempt failed, by name.
 *
 * The connector families spell the same idea as `status: 'failed'` does, one
 * table over: `recordSyncError` and `recordImportError` move a *connection* to
 * `error` and put the reason on it. Refusing to write one because the
 * engagement was withdrawn mid-pull loses the record of an import that was
 * genuinely attempted and leaves the connection due, which is the state R186
 * and R261 exist to remove. Neither touches the engagement's own content.
 */
const ATTEMPT_WRITER = /\brecord(Sync|Import)Error\(/;

/**
 * Reading forward from an outbound call to the first write, a "handler" ends at
 * the next route registration. Anything past that belongs to a different
 * request and its own guard.
 */
const HANDLER_END =
  /^\s*(app|deps\.app)\.(get|post|put|patch|delete)\(|^\}|^(export )?(async )?function |^(export )?const \w+ = (async )?\(/;

interface Gap {
  file: string;
  line: number;
  write: string;
}

function routeFiles(): string[] {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith('.ts'))
    .sort();
}

function gapsIn(file: string): Gap[] {
  const lines = readFileSync(join(ROUTES, file), 'utf8').split('\n');
  const gaps: Gap[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!OUTBOUND.test(lines[i]!)) continue;
    // Forward to the first write, or to the end of this handler.
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (HANDLER_END.test(line)) break;
      // A re-ask before the write settles this call; nothing further to say.
      if (REASK.test(line)) break;
      // Another outbound call: the next iteration of the outer loop owns it.
      if (OUTBOUND.test(line)) break;
      if (!WRITE.test(line) || AUDIT_WRITE.test(line) || ATTEMPT_WRITER.test(line)) continue;
      // An attempt record rather than a conclusion — look a few lines ahead for
      // the status the writer is passing.
      const body = lines.slice(j, j + 12).join('\n');
      if (ATTEMPT_RECORD.test(body)) break;
      gaps.push({ file, line: j + 1, write: line.trim() });
      break;
    }
  }
  return gaps;
}

describe('a write on the far side of a round trip', () => {
  it('re-asks whether the engagement is still live', () => {
    const gaps = routeFiles().flatMap(gapsIn);
    expect(
      gaps,
      gaps.length === 0
        ? ''
        : 'these writes land after the handler left the process, on an engagement it last ' +
            'looked at before it did:\n' +
            gaps.map((g) => `  ${g.file}:${g.line}  ${g.write}`).join('\n') +
            '\nAdd refuseIfRetiredNow (or refuseIfSubjectRetiredIn, inside the write transaction) ' +
            'immediately before the write.',
    ).toEqual([]);
  });

  /**
   * The population is not empty, and the matcher can see a real gap.
   *
   * A census that scans the wrong shape passes by finding nothing, which is the
   * failure this codebase keeps naming. Both halves are checked against the
   * source itself: there are outbound calls in route files to walk forward
   * from, and removing a re-ask from one of them is caught.
   */
  it('is looking at a population, and would notice a missing guard', () => {
    const withOutbound = routeFiles().filter((f) => OUTBOUND.test(readFileSync(join(ROUTES, f), 'utf8')));
    expect(withOutbound.length).toBeGreaterThan(8);

    const calculations = readFileSync(join(ROUTES, 'calculations.ts'), 'utf8');
    expect(REASK.test(calculations)).toBe(true);
    // The same file with its re-ask struck out has to fail the scan, or the
    // assertion above is about a guard nothing checks the absence of.
    const stripped = calculations.replace(/await refuseIfRetiredNow\([^)]*\);/g, '');
    const lines = stripped.split('\n');
    let found = false;
    for (let i = 0; i < lines.length && !found; i += 1) {
      if (!OUTBOUND.test(lines[i]!)) continue;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (HANDLER_END.test(lines[j]!) || REASK.test(lines[j]!) || OUTBOUND.test(lines[j]!)) break;
        if (!WRITE.test(lines[j]!) || AUDIT_WRITE.test(lines[j]!) || ATTEMPT_WRITER.test(lines[j]!)) continue;
        if (ATTEMPT_RECORD.test(lines.slice(j, j + 12).join('\n'))) break;
        found = true;
        break;
      }
    }
    expect(found, 'the scan found no gap in calculations.ts with its guard removed').toBe(true);
  });
});
