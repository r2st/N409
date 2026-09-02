import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A repo that changes an engagement's state puts it on the engagement's spine,
 * or says here why not.
 *
 * `valuation_events` is the record architecture §1 calls "everything is an
 * event on the Valuation", and it is what the change log, the evidence bundle,
 * the client portal and the auditor's export all read. A write that reaches it
 * is visible; a write that does not happened, changed a figure, and left
 * nothing for anybody reconstructing why the number moved.
 *
 * The estate has closed this gap three times by hand and never derived the
 * population. R279 found the fund and debt measurement surfaces — eleven event
 * types at once, because two ops tools had been linked to engagements
 * afterwards and neither route file had ever written a row. R388 found
 * `valuation_signatures`: a re-sign wrote over the prior signatory and a
 * withdrawal removed the row, both without a trace. R392 found two more —
 * `asc718_settings`, the election that decides the stock-compensation charge,
 * and `auditor_access`, the only door that hands a reader with no account the
 * deliverable. Every one of those was found by reading files and comparing
 * them with their neighbours, which is the search that finds the fifth one
 * whenever somebody happens to run it.
 *
 * So the membership is derived from the writes themselves: a repo that mentions
 * `valuation_id` and carries an INSERT, UPDATE or DELETE is in, and it must
 * either record on the spine — itself, or through a module that imports it — or
 * appear in {@link DECIDED} with a reason. Both directions are asserted, so a
 * new engagement-scoped repo fails here rather than shipping silent, and an
 * entry whose repo has since gained an event fails as a position about nothing.
 *
 * The heuristic is deliberately generous on the way in: `valuation_id` in a
 * read predicate is enough to be asked the question. Two members are here only
 * because of that, and both say so below. A false positive costs one line of
 * argument; a false negative is the bug this file exists to catch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const REPOS = path.join(SRC, 'repos');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every module outside `repos/`, which is where a route-level recorder lives. */
const consumers = sources(SRC)
  .filter((f) => !f.startsWith(REPOS + path.sep))
  .map((f) => ({ name: path.relative(SRC, f).split(path.sep).join('/'), source: readFileSync(f, 'utf8') }));

/** `recordEvent(` and `recordEvents(` — the batch writer is the same spine. */
const RECORDS = /recordEvents?\s*\(/;

/** A statement that changes a row, as opposed to one that reads one. */
const WRITES = /INSERT INTO|UPDATE\s+[a-z_]+\s+SET|DELETE FROM/;

interface RepoModule {
  file: string;
  /** True when this module writes the spine itself. */
  here: boolean;
  /** Modules that import it and write the spine. */
  via: string[];
}

const population: RepoModule[] = readdirSync(REPOS)
  .filter((n) => n.endsWith('.ts'))
  .flatMap((name) => {
    const source = readFileSync(path.join(REPOS, name), 'utf8');
    if (!source.includes('valuation_id') || !WRITES.test(source)) return [];
    const spec = `repos/${name.replace(/\.ts$/, '.js')}`;
    return [
      {
        file: name,
        here: RECORDS.test(source),
        via: consumers.filter((c) => c.source.includes(spec) && RECORDS.test(c.source)).map((c) => c.name),
      },
    ];
  });

const offSpine = population.filter((m) => !m.here && m.via.length === 0).map((m) => m.file);

/**
 * The engagement-scoped repos that do not reach `valuation_events`, and why.
 *
 * Each was looked at in round 392 and left alone on the stated ground, so the
 * next round argues with a position rather than re-deriving one. "On the admin
 * spine" is a real answer and not a synonym for silence: `admin_events` is read
 * by the ops activity feed, which is the reader those surfaces have.
 */
const DECIDED: Record<string, string> = {
  'accountingConnections.ts':
    'a connector, journalled in connector_sync_log through domain/connectorSyncLog.ts — the state machine R258/R261 built, with its own panel and its own terminal/transient failure logging.',
  'capTableConnections.ts': 'the same connector journal; routes/capTableSync.ts logs through it six times.',
  'hrisConnections.ts': 'the same connector journal; routes/hris.ts logs through it six times.',
  'adminUsers.ts':
    'identity, on the admin spine — an account is not one engagement’s state, and admin_events is where the ops feed reads it.',
  'communications.ts':
    'its writes are the templates and the automated-email rules, which are partner-scoped and audited on the admin spine; `valuation_id` appears here only in the candidate-selection reads.',
  'notifications.ts':
    'a notification is a copy addressed to one reader. What happened is recorded by whatever wrote it — the state change, the comment, the job alert — and a row per recipient beside it would say the same thing N times.',
  'payments.ts':
    'money, on the billing audit spine R215 built: every payment transition writes admin_events, which is the surface the finance reader has.',
  'retention.ts':
    'the retention policies and the sweeps, on the admin spine — routes/retention.ts writes ten of them.',
  'valuationPurge.ts':
    'a purge deletes the engagement and its events with it, so the record of it can only live on the admin spine, where routes/retention.ts puts it.',
  'valuationTags.ts':
    'an ops taxonomy over the book rather than an input to any one valuation; on the admin spine, from both writers.',
  'emailOutbox.ts':
    'the outbox row is itself the record of a message, with the delivery rows and the retry ladder beside it. The engagement action that caused the send writes its own event.',
  'inbox.ts':
    'per-(reader, engagement) read state. Unread is a property of the reader — see the repo’s own note on why it is not `last_comment_at` — and no reader’s inbox is a fact about the engagement.',
  'networkItems.ts':
    'the journal of outbound calls: this is an observability record, not engagement state, and putting it on the spine would file the trail inside the thing it describes.',
};

describe('engagement spine census', () => {
  it('is looking at a real population', () => {
    // A matcher that stops matching passes both directions below trivially.
    expect(population.length).toBeGreaterThan(30);
    expect(population.map((m) => m.file)).toContain('params.ts');
    expect(population.find((m) => m.file === 'companyProfiles.ts')?.here).toBe(true);
    // Recorded by their route rather than by themselves — the `via` arm has to
    // be doing work, or every route-level recorder reads as a gap.
    expect(population.find((m) => m.file === 'scenarios.ts')?.via.length).toBeGreaterThan(0);
  });

  it('has every engagement-scoped repo on the spine or argued here', () => {
    // R392's two: `asc718Settings.ts` and `auditorAccess.ts` were both in this
    // list and in neither of the two arms above. A new one is a failure with a
    // filename in it.
    expect(offSpine.filter((f) => !(f in DECIDED)).sort()).toEqual([]);
  });

  it('argues nothing that has since been settled', () => {
    // The other direction. A repo that gained an event keeps its exemption
    // forever otherwise, and the exemption then hides the next repo to lose it.
    expect(
      Object.keys(DECIDED)
        .filter((f) => !offSpine.includes(f))
        .sort(),
    ).toEqual([]);
  });

  it('would have caught what R392 fixed', () => {
    // The discriminator: both fixes are in the population and on the spine now,
    // and neither is in DECIDED. Had either been left as it was, the first
    // assertion would name it.
    for (const file of ['asc718Settings.ts', 'auditorAccess.ts']) {
      const found = population.find((m) => m.file === file);
      expect(found, `${file} must stay in the population`).toBeDefined();
      expect(found!.here || found!.via.length > 0).toBe(true);
      expect(file in DECIDED).toBe(false);
    }
  });
});
