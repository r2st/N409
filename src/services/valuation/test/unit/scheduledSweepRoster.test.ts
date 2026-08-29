import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every scheduled sweep is accounted for, or this fails.
 *
 * R89 asked all 86 mutating valuation-scoped *routes* whether the engagement
 * had been retired. The sweep it wrote to find the ten that did not drives
 * routes, so it could not see the eleven timers this process also starts — and
 * four of those wrote to a valuation without going through a route at all. A
 * firm could withdraw an engagement, watch every button in the product stop
 * accepting changes, and have a timer go on pulling their cap table from Carta.
 *
 * The lesson R90 wrote down is that a guard phrased as "account for every X"
 * catches the additions its author never imagined, while one phrased as "these
 * known X are fine" only ever catches regressions. So this is the first kind:
 * it reads the sweep names out of `index.ts` and fails on any it has never
 * been told about. A new timer cannot ship without somebody writing down, here,
 * whether it can touch a valuation.
 *
 * It deliberately proves nothing about behaviour — `retiredSweepWrites.test.ts`
 * drives the four that can. This is the census that says the four are all of
 * them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(join(here, '../../src/index.ts'), 'utf8');

type Verdict = { writesValuation: true; guardedBy: string } | { writesValuation: false; because: string };

/**
 * The decision for each sweep. `writesValuation` means "can this, on its own
 * schedule, change a valuation or produce something from one" — which is the
 * question `refuseIfRetired` asks of a route.
 */
const DECIDED: Record<string, Verdict> = {
  'auto-email': {
    writesValuation: true,
    // R56. The candidate query is the filter: `v.archived_at IS NULL` in
    // repos/communications.ts.
    guardedBy: 'autoEmailCandidates joins valuations and requires archived_at IS NULL',
  },
  'email-retry': {
    writesValuation: true,
    // The worst of the four, and the one R89 already named in its other form:
    // a "we still need your cap table" queued the day before the withdrawal,
    // whose first send failed, delivered by the ladder afterwards. Mail cannot
    // be un-sent.
    guardedBy: 'claimRetryableEmails excludes rows whose valuation is archived',
  },
  'cap-table-sync': {
    writesValuation: true,
    guardedBy: 'findDueConnections joins valuations and requires archived_at IS NULL',
  },
  'hris-sync': {
    writesValuation: true,
    guardedBy: 'findDueConnections joins valuations and requires archived_at IS NULL',
  },
  'pipeline-retry': {
    writesValuation: true,
    guardedBy: 'retryFailedPipelineRuns settles a claimed run whose valuation is archived',
  },
  'webhook-retry': {
    writesValuation: false,
    // Deliberately not guarded, and it would be a bug to guard it: R90's
    // `valuation.retired` event is delivered by this ladder, so a filter on
    // archived valuations would drop the very notice that says the work
    // stopped. It writes to `partner_webhook_deliveries`, never to a valuation.
    because: 'delivers webhooks, including the retirement notice itself',
  },
  'pipeline-reaper': {
    writesValuation: false,
    because: 'fails runs stuck in an active status; it only ever stops work',
  },
  'ai-job-reaper': {
    writesValuation: false,
    // R186's sibling of the one above, and the same reading: it settles
    // `ai_jobs` rows left running by a process that stopped existing, which is
    // strictly the removal of work. It writes no valuation column — the
    // completion event it records is the audit trail of the settlement, and an
    // archived engagement's orphaned job is exactly as owed a terminal status
    // as a live one's.
    because: 'settles AI jobs stuck at running; it only ever stops work',
  },
  'job-alerts': {
    writesValuation: false,
    because: 'reads job counts and raises alerts; touches no valuation',
  },
  retention: {
    writesValuation: false,
    // It is the thing that sets `archived_at`. A guard here would make it
    // unable to do its job — the same shape as `restore` in the R89 route
    // sweep, which must not be guarded for the same reason.
    because: 'it is the archiver; guarding it would make it unable to archive',
  },
  housekeeping: {
    writesValuation: false,
    because: 'deletes spent tokens, invitations and trusted devices; no valuation column',
  },
};

/**
 * `scheduleSweep('name', …)` is how index.ts registers a sweep.
 *
 * It used to be `track('name', …)`, and R155 moved the literal one call deeper:
 * `scheduleSweep` is what now calls `track`, passing the name as a *variable*
 * so the drain roster, the two saturation gauges and the failure line all get
 * the same string by construction. This regex followed it, and the vacuity
 * guard below is what forced the follow — with the old pattern still here every
 * assertion in this file passed against an empty set.
 */
function sweepNames(source: string): string[] {
  return [...source.matchAll(/\bscheduleSweep\(\s*\n?\s*'([a-z0-9-]+)'/g)].map((m) => m[1]!);
}

describe('the scheduled sweeps', () => {
  const found = sweepNames(INDEX);

  it('finds the sweeps at all — the vacuity guard for everything below', () => {
    // A regex that stopped matching would make every assertion here pass
    // against an empty set, which is exactly the trap R89's nested-route scan
    // fell into.
    expect(found.length).toBeGreaterThanOrEqual(9);
    expect(found).toContain('cap-table-sync');
    expect(found).toContain('retention');
  });

  it('has a decision recorded for every sweep this process starts', () => {
    const undecided = found.filter((name) => !(name in DECIDED));
    // If this fails, a timer has been added and nobody has said whether it can
    // touch a valuation. Answer it in DECIDED above — and if the answer is
    // yes, drive it in retiredSweepWrites.test.ts before writing it down here.
    expect(undecided).toEqual([]);
  });

  it('has no decision for a sweep that no longer exists', () => {
    // The other direction. A stale entry is how a decision list stops
    // describing the system and starts being folklore.
    const stale = Object.keys(DECIDED).filter((name) => !found.includes(name));
    expect(stale).toEqual([]);
  });

  it('registers every sweep through the one helper that carries the alert contract', () => {
    // R155. `sweepFailed` classifies a failed tick and stamps `alert: true` on
    // the permanent ones — the only alerting contract this codebase declares,
    // and until R155 it had no production callers at all while the ten sweeps
    // here each hand-wrote `log.error({ err }, '<name> sweep failed')`.
    //
    // `scheduleSweep` is what supplies it. A sweep built by scheduling its tick
    // directly would still run, still be tracked if somebody remembered
    // `track`, and still log — with no `sweep` field, no classification, and
    // nothing an alert rule can match. So the guard is on the construction
    // rather than on the roster: there is exactly one scheduler call in this
    // file and it is inside `scheduleSweep`.
    //
    // The spelling moved in R206. `trackedSweep` (packages/shared) is now what
    // pairs `nonOverlapping` with `sweepFailed`, and binds `{ sweep, sweepRun }`
    // around the tick so the interior lines of twelve sweeps sharing one logger
    // can be told apart. Both spellings are checked: one call of the helper, and
    // no sweep reaching past it to `nonOverlapping` on its own.
    const code = INDEX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/([^:])\/\/[^\n]*/g, '$1');
    expect([...code.matchAll(/\bnonOverlapping\(/g)]).toHaveLength(0);
    expect([...code.matchAll(/\btrackedSweep\(/g)]).toHaveLength(1);
    expect(code).toMatch(/const scheduleSweep = [^;]*trackedSweep\(app\.log, name, tick\)/);
  });

  it('says how each valuation-writing sweep is guarded', () => {
    const writers = Object.entries(DECIDED).filter(([, v]) => v.writesValuation);
    // Five of the ten write to a valuation on their own schedule. That is the
    // number worth knowing: it is five more than the route sweep could see.
    expect(writers).toHaveLength(5);
    for (const [name, verdict] of writers) {
      expect(verdict, name).toHaveProperty('guardedBy');
      expect((verdict as { guardedBy: string }).guardedBy.length).toBeGreaterThan(20);
    }
  });
});
