import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every statement that writes a `status` column, and whether the state it is
 * writing over is allowed to be written over.
 *
 * The shape this exists for is one bug wearing four faces, and R224 found it in
 * three subsystems at once. A row reaches a state that is meant to be the end
 * of it — a revoked integration, a reaped job, a settled outbox row — and a
 * writer that has been holding a stale copy since before that happened arrives
 * afterwards and puts the row back. The write itself looks correct in isolation:
 * it records something that genuinely happened. What it cannot know is that it
 * is no longer the thing that happened *last*.
 *
 *   * `settleClaimedEmail` wrote a transport failure over a message a second
 *     sweeper had already delivered, and stamped it a fresh place on the retry
 *     ladder — so the mail went out again.
 *   * `completeAiJob` reopened a reaped run as succeeded and put a second
 *     ending on the audit spine.
 *   * the three connector repos reported a connection the client had just
 *     severed as `connected`, `last_error` cleared, over a blanked token.
 *
 * The roster below is the census, in the shape R90 settled on: this reads every
 * `UPDATE … SET … status =` out of the source and fails on one it has never
 * been told about. It proves nothing about behaviour — the integration tests
 * beside each fix drive the races — only that a new status writer cannot ship
 * without somebody deciding here whether a terminal state can stop it.
 *
 * `guard` is the predicate as it appears in the WHERE; `unguarded` carries the
 * reason it does not need one, which is normally that the write is already
 * serialized (a `FOR UPDATE` above it) or that the column has no terminal state
 * to protect.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../../src');

type Verdict = { guard: string } | { unguarded: string };

/** Keyed by file and table, which is what says which state machine is meant. */
const DECIDED: Record<string, Verdict> = {
  'repos/accountingConnections.ts :: accounting_connections': {
    guard: "status <> 'revoked' on both bookkeeping writes; the revoke itself refuses to run twice",
  },
  'repos/aiJobs.ts :: ai_jobs': {
    guard: "status = 'running' on the settle; the reaper's own UPDATE runs under FOR UPDATE SKIP LOCKED",
  },
  'repos/billing.ts :: subscriptions': {
    guard: "status <> 'canceled', and the upsert reports `newly_canceled` off the previous row",
  },
  'repos/boardApprovals.ts :: board_signoffs': {
    guard: "status = 'pending' — a director's decision is write-once",
  },
  'repos/boardApprovals.ts :: board_resolutions': {
    unguarded:
      'the aggregate is recomputed from the sign-offs under a FOR UPDATE on the resolution, and a ' +
      'member added or removed is meant to move it — except out of `approved`, which R288 refuses ' +
      'under that same lock rather than letting an addition clear an approval and its `approved_at`; ' +
      "the upsert's `DO UPDATE` writes 'pending' over any status at all, which is a regeneration the " +
      'operator asked for — R312 records it as `board_resolution_reopened` rather than refusing it, ' +
      'because a decided resolution replaced silently is an approval withdrawn with nothing on the spine',
  },
  'repos/capTableConnections.ts :: cap_table_connections': {
    guard:
      "status <> 'revoked' on the sync bookkeeping and on the cadence write, and the sync " +
      'bookkeeping also pins `auth_generation` — a reconnect during a pull supersedes it, and ' +
      "'revoked' cannot say that (migration 0197)",
  },
  'repos/contactSubmissions.ts :: contact_submissions': {
    unguarded: 'new → handled, by one operator, on a form nothing else writes',
  },
  'repos/emailOutbox.ts :: email_outbox': {
    guard:
      'the settle pins `attempts` to the value the claim stamped; markEmail is the unclaimed path; ' +
      "R272's retirement writes only `status = 'queued'` rows whose lease has expired and whose " +
      'attempts are spent, which is the one queued state no claim can reach',
  },
  'repos/grants.ts :: option_grants': {
    guard: "status = 'active' — a grant is cancelled once, and the event dates the forfeiture",
  },
  'repos/hrisConnections.ts :: hris_connections': {
    guard:
      "status <> 'revoked' on the sync bookkeeping and on the cadence write, and the sync " +
      'bookkeeping also pins `auth_generation` — a reconnect during a pull supersedes it, and ' +
      "'revoked' cannot say that (migration 0197)",
  },
  'repos/partnerWebhooks.ts :: partner_webhook_deliveries': {
    guard: "status = 'pending' AND attempts = the claim's, and a replay may reopen a delivered row",
  },
  'repos/payments.ts :: payments': {
    guard: 'the caller names the statuses the move is legal from, and the refund checks the amount too',
  },
  'repos/pipelineRuns.ts :: pipeline_runs': {
    guard:
      "status NOT IN ('ready','failed') AND attempts = the caller's — the second is what stops a " +
      'reaped worker writing over the attempt the retry ladder started in its place; the reaper and ' +
      'the retry claim run under FOR UPDATE SKIP LOCKED',
  },
  'repos/reportTemplates.ts :: report_templates': {
    unguarded:
      'activate re-reads the row under a lock on the template *name*, and under that lock R288 ' +
      'refuses an archived target — the route refuses it on the pool, and an archive committing in ' +
      'between used to restore the row and archive the live one on its way; archive is deliberately ' +
      'reachable from any status — a skeleton is withdrawn from whatever state it is in',
  },
  'repos/support.ts :: support_messages': {
    unguarded: 'open → resolved, by one operator, on a thread nothing else writes',
  },
  'repos/valuationTags.ts :: valuation_tags': {
    guard:
      "the upsert's CASE refuses to move a tag an ai re-suggestion did not decide — a human " +
      "'accepted' or 'rejected' survives the next tagging run; `decideValuationTag` is the " +
      "operator's own write and is deliberately outside that CASE, because `source` records where " +
      'a tag came from and not who is writing — R356 found an accepted AI tag that could not be ' +
      "rejected, nor demoted by the exclusivity rule, because the decision doors handed the row's " +
      'own origin back to a clause that reads it as a machine; since R448 the decision carries ' +
      '`status <> $3`, so a decision already taken is not re-dated or re-attributed by a second press',
  },
  'repos/tasks.ts :: review_tasks': {
    unguarded:
      'a review task is meant to move both ways — reopening one clears `completed_at` in the same ' +
      'statement, so no reading can disagree with the status',
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** True when the file declares a patchable-column list that includes `status`. */
function allowsStatusColumn(text: string): boolean {
  const list = /(?:COLUMNS|FIELDS)\s*=\s*(?:new Set\()?\[([^\]]*)\]/.exec(text);
  return list ? /'status'/.test(list[1]!) : false;
}

/**
 * Every statement in the service that can move a `status` column, by file and
 * table.
 *
 * Three things this had to be taught, each of which hid a real writer on the
 * first pass — the reason the roster carries a stale-entry check as well as an
 * unknown-entry one, so a detector that stops seeing something fails here
 * rather than going quiet:
 *
 *   * an upsert's `ON CONFLICT … DO UPDATE SET` writes the table named by the
 *     INSERT, not the word after `UPDATE`;
 *   * a statement whose SET clause is assembled in JavaScript
 *     (`SET ${sets.join(', ')}`) carries no literal `status =` at all —
 *     `patchTask` is one, and a matcher reading only literals declared the
 *     table unwritten;
 *   * bounding a match at the closing backtick is what stops one template
 *     running into the next and attributing a guard to the wrong statement.
 */
function statusWriters(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    const key = relative(SRC, file);
    // Bounded at the closing backtick so one statement cannot run into the next.
    //
    // `(?<!FOR )` because `FOR UPDATE SKIP LOCKED` is not a statement start
    // (round 272, methodology M3). The lock clause reads as `UPDATE SKIP`, and
    // the match then runs on to the closing backtick — so a CTE that takes rows
    // `FOR UPDATE SKIP LOCKED` and settles a status in the outer UPDATE was
    // reported twice: once correctly, against its table, and once as a writer of
    // a table called `SKIP`. Only a statement whose SET names `status` reaches
    // the roster at all, which is why the claim-shaped statements already here
    // never showed it. `NOWAIT` and `FOR UPDATE OF d` are the same clause and
    // the same fix.
    for (const match of text.matchAll(/(?:INSERT\s+INTO|(?<!FOR )UPDATE)\s+(\w+)[^`]*/g)) {
      const statement = match[0];
      const literal = /\bSET\b[\s\S]*?\bstatus\s*=/i.test(statement);
      // A SET clause assembled from a column allow-list writes whatever the
      // list permits, and `status` is named in TypeScript rather than in the
      // SQL — invisible to the literal match above. Only the file that
      // allow-lists the column counts, so the many generic patch builders that
      // cannot reach a status column are not swept in with it.
      const dynamic = /\bSET\b[\s\S]{0,40}\$\{/.test(statement) && allowsStatusColumn(text);
      if (!literal && !dynamic) continue;
      found.add(`${key} :: ${match[1]}`);
    }
  }
  return found;
}

describe('the writers of a status column', () => {
  const writers = statusWriters();

  it('are all accounted for', () => {
    const undecided = [...writers].filter((key) => !(key in DECIDED)).sort();
    expect(undecided, 'a new status writer: say in DECIDED whether a terminal state can stop it').toEqual([]);
  });

  it('has no roster entry for a writer that no longer exists', () => {
    const stale = Object.keys(DECIDED)
      .filter((key) => !writers.has(key))
      .sort();
    expect(stale, 'these roster entries describe statements that are gone').toEqual([]);
  });

  it('states a predicate for each one that claims to have a guard', () => {
    for (const [key, verdict] of Object.entries(DECIDED)) {
      if ('guard' in verdict) expect(verdict.guard.length, key).toBeGreaterThan(0);
      else expect(verdict.unguarded.length, key).toBeGreaterThan(0);
    }
  });
});
