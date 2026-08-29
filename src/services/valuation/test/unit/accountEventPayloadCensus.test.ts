import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No admin event about a person names another person in its payload.
 *
 * `buildPersonalDataExport` now answers an Art. 15 request with the rows of
 * `admin_events` whose subject is the requester, and it makes one careful
 * omission: `actor_id` is not selected, because which administrator carried
 * the action out is another person's data. That is the same call the export
 * makes about `email_suppressions.released_by` and
 * `contact_submissions.handled_by`.
 *
 * `payload` is selected whole, and it has to be — it is where the substance
 * of an event lives (which roles, which method, which fields) and it is
 * free-form `jsonb`, so there is no schema to enumerate against. That makes it
 * the one field through which the omission can be undone, and it had been:
 * `user_promoted` and `user_demoted` each wrote `promoted_by` / `demoted_by`
 * into the payload, duplicating the `actor_id` column `recordAdminEvent` fills
 * from the very same value. Nothing read either one. The whole effect was to
 * put the withheld fact back into the copy through the field nobody was
 * governing.
 *
 * The rule is stated over the source rather than over a sample of rows,
 * because a row only exists once somebody has been promoted: a test over data
 * passes on a fresh database while the call site is still writing the key.
 *
 * `_by` is the shape rather than a list of names. On this schema an actor is
 * always spelled that way — `created_by`, `updated_by`, `invited_by`,
 * `handled_by`, `released_by`, `placed_by`, `resolved_by`, the whole
 * `ACTOR_COLUMNS` class in `personalDataCensus` — so a family is the honest
 * rule here where it is not for `_name` or `_email`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Every `payload:` object literal that belongs to a user-subject audit write.
 *
 * Two call shapes reach `recordAdminEvent` and both have to be read. The
 * direct one names `subjectType: 'user'` and `payload: { … }` in the same
 * object literal. The other is the ten route-local `audit(...)` helpers, whose
 * subject type is a positional string — `audit(actor, type, 'user', id,
 * label, { … })` — so the payload is the last argument and the subject type is
 * the third. Reading only the first shape would have missed `adminUsers.ts`
 * entirely, which is where both offending keys were.
 */
function userSubjectPayloads(): Array<{ file: string; keys: string[] }> {
  const out: Array<{ file: string; keys: string[] }> = [];
  const push = (file: string, body: string) => {
    // Top-level keys only: a nested object is a value somebody assembled, and
    // the two cases this exists for are flat.
    const keys = [...body.matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*:/gi)].map((m) => m[1]!);
    if (keys.length) out.push({ file: path.relative(SRC, file), keys });
  };
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/subjectType:\s*'user'[\s\S]{0,600}?payload:\s*\{([^{}]*)\}/g))
      push(file, m[1]!);
    for (const m of src.matchAll(/\baudit\(\s*[^;]*?,\s*'user'\s*,[^;]*?\{([^{}]*)\}\s*\)/g))
      push(file, m[1]!);
  }
  return out;
}

const payloads = userSubjectPayloads();

describe('an audit event about a person does not name another person', () => {
  it('finds the payloads at all', () => {
    // Vacuity guard: the assertion below is over `payloads`, and two regexes
    // over TypeScript that stopped matching would report a clean estate of
    // nothing. Pinned to the two files that certainly carry such writes.
    expect(payloads.length).toBeGreaterThan(5);
    const files = new Set(payloads.map((p) => p.file));
    expect([...files].some((f) => f.endsWith('routes/adminUsers.ts'))).toBe(true);
    expect([...files].some((f) => f.endsWith('routes/scim.ts'))).toBe(true);
  });

  it('puts no actor-shaped key in a payload the subject can read', () => {
    const offenders = payloads
      .flatMap(({ file, keys }) => keys.filter((k) => /_by$/.test(k)).map((k) => `${file}: ${k}`))
      .sort();
    // The actor belongs in `actor_id`, which `recordAdminEvent` already fills
    // and the export already withholds. If a payload genuinely needs to say
    // something about who acted, it must say it without naming them.
    expect(offenders).toEqual([]);
  });
});
