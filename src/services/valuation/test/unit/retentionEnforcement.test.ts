import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RETENTION_ACTION_NAMES,
  RETENTION_DATA_TYPES,
  RETENTION_ENFORCEMENT,
  type RetentionDataType,
} from '../../src/domain/retention.js';

/**
 * Which retention policies actually do something, held against the code that
 * would have to do it.
 *
 * Feature 10 shipped five configurable data types and a sweep that implemented
 * one. `document`, `calculation`, `email_outbox` and `audit_event` were
 * accepted by `PUT /admin/retention/policies/:dataType`, stored, listed back to
 * the console, rendered as three numbers and a checkbox exactly like the type
 * that worked — and read by nothing. `runRetentionSweep` said so in a comment
 * ("Extend here for additional data types") and `domain/housekeeping.ts` said
 * the opposite in prose ("audit events, activity, notifications and the email
 * outbox all age out through the retention policy engine"), which is the state
 * a control ends up in when nothing checks.
 *
 * A compliance control that saves and does nothing is worse than an absent
 * one. Absent is visible; this looked identical to enforcement from every
 * surface an operator could see, over a table holding recipients' addresses and
 * message bodies.
 *
 * So the enforcement is declared, and this file is the thing that keeps the
 * declaration true. It reads the sweep's source rather than running it,
 * deliberately: the integration tests prove the outbox purge *behaves*, and
 * what is at issue here is the type nobody wrote a branch for — a behaviour
 * test can only ever assert about branches that exist.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWEEP_SRC = readFileSync(path.resolve(HERE, '../../src/routes/retention.ts'), 'utf8');
const HOUSEKEEPING_SRC = readFileSync(path.resolve(HERE, '../../src/domain/housekeeping.ts'), 'utf8');

/**
 * The data types the sweep's source actually names.
 *
 * Matched on the string literal in a `data_type ===` comparison or a
 * `dataType:` field, which are the only two ways this file can reach a policy:
 * it finds the policy by comparing, and it records the action by naming. A
 * type that appears in neither cannot be being acted on.
 */
function typesNamedBySweep(): Set<string> {
  const found = new Set<string>();
  for (const m of SWEEP_SRC.matchAll(/data_type === '([a-z_]+)'/g)) found.add(m[1]!);
  for (const m of SWEEP_SRC.matchAll(/dataType: '([a-z_]+)'/g)) found.add(m[1]!);
  return found;
}

describe('the retention policies that do something, and the ones that do not', () => {
  it('declares an enforcement for every data type the console can set', () => {
    // The console's rows are `RETENTION_DATA_TYPES`, so a type with no entry
    // here is a row that renders with nothing said about it — which is the
    // state all five were in.
    const undeclared = RETENTION_DATA_TYPES.filter((t) => !(t in RETENTION_ENFORCEMENT));
    expect(undeclared, 'data types with no declared enforcement').toEqual([]);
  });

  it('declares no enforcement for a data type that does not exist', () => {
    const stale = Object.keys(RETENTION_ENFORCEMENT).filter(
      (t) => !(RETENTION_DATA_TYPES as readonly string[]).includes(t),
    );
    expect(stale).toEqual([]);
  });

  it('gives every enforcement a reason somebody could read out', () => {
    // Same standard as the dispositions in `piiInventory.test.ts`: "not
    // enforced" is an acceptable answer and an unexplained one is not, because
    // the note is what the console shows an operator who is about to tick a
    // box.
    const thin = Object.entries(RETENTION_ENFORCEMENT).filter(([, e]) => e.note.trim().length < 120);
    expect(thin.map(([t]) => t)).toEqual([]);
  });

  it('finds the data types the sweep names', () => {
    // Vacuity guard, in the direction that matters: if the scan stopped
    // matching, every "enforced" claim below would be reported as unbacked and
    // every "not enforced" claim would pass. The first is loud; the second is
    // the one that would be believed.
    const named = typesNamedBySweep();
    expect(named).toContain('valuation');
    expect(named).toContain('email_outbox');
  });

  it('backs every enforced claim with a branch in the sweep', () => {
    const named = typesNamedBySweep();
    const claimed = (
      Object.entries(RETENTION_ENFORCEMENT) as [RetentionDataType, { archives: boolean; purges: boolean }][]
    )
      .filter(([, e]) => e.archives || e.purges)
      .map(([t]) => t);
    for (const type of claimed) {
      expect(named, `${type} is declared enforced but the sweep never names it`).toContain(type);
    }
  });

  it('does not let the sweep act on a type declared inert', () => {
    // The other direction, and the one that goes stale silently: somebody adds
    // a `document` branch and the console keeps telling operators the setting
    // is not enforced.
    const named = typesNamedBySweep();
    const inert = (
      Object.entries(RETENTION_ENFORCEMENT) as [RetentionDataType, { archives: boolean; purges: boolean }][]
    )
      .filter(([, e]) => !e.archives && !e.purges)
      .map(([t]) => t);
    const acted = inert.filter((t) => named.has(t));
    expect(acted, 'data types the sweep touches but the declaration calls inert').toEqual([]);
  });

  it('records the count of enforced policies, so a regression is a diff', () => {
    // Stated positively for the reason `piiInventory` states its `kept` list
    // that way: two of five is the finding, and a change in either direction
    // should have to be written down rather than merged.
    const enforced = Object.entries(RETENTION_ENFORCEMENT)
      .filter(([, e]) => e.archives || e.purges)
      .map(([t]) => t)
      .sort();
    expect(enforced).toEqual(['email_outbox', 'valuation']);
  });

  it('keeps the housekeeping sweep from claiming the retention engine does more than it does', () => {
    // The prose that was wrong. `domain/housekeeping.ts` explains what it
    // deliberately leaves to the retention engine, and it named three data
    // types the engine has never acted on. Rather than trusting the corrected
    // sentence to stay corrected, the claim is pinned: it may not name a type
    // this file calls inert.
    // The doc block only — the targets below it are a different subject.
    const doc = HOUSEKEEPING_SRC.slice(0, HOUSEKEEPING_SRC.indexOf('export interface HousekeepingTarget'));
    expect(RETENTION_ENFORCEMENT.audit_event.archives || RETENTION_ENFORCEMENT.audit_event.purges).toBe(
      false,
    );
    expect(doc, 'the corrected paragraph must not re-acquire the claim').not.toMatch(
      /[Aa]udit events,? .*age out/,
    );
    expect(doc).toMatch(/email outbox ages out/);
  });

  it('knows the same action names the database will accept', () => {
    // The CHECK on `retention_actions.action` (migrations 0083, 0165, 0174) is
    // the real constraint; this union is what the code is allowed to write.
    // They drifting apart is a 23514 in a background sweep, which is the worst
    // place to find out.
    const migrations = path.resolve(HERE, '../../migrations/0174_retention_purge_action.sql');
    const sql = readFileSync(migrations, 'utf8');
    const inCheck = [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...RETENTION_ACTION_NAMES].sort()).toEqual([...new Set(inCheck)].sort());
  });
});
