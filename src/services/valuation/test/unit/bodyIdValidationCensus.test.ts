import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ulidField } from '../../src/domain/ulidField.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * An id carried in a body or a query string is validated as one (round 331).
 *
 * `plugins/params.ts` closed this for route *parameters*, with a hook and a
 * census over the whole route table, because ~190 handlers were casting
 * `req.params` and passing the string to a repo. The identical string arriving
 * one layer over — in the JSON body, or in `?partner_id=` — had no such rule,
 * and most schemas spelled it `z.string()`, which accepts every string there is.
 *
 * What actually got through was the *empty* one, and the reason is the shape
 * the handlers are written in:
 *
 *     if (body.parent_org_id) await loadOwnedOrg(principal, body.parent_org_id);
 *     …
 *     { parentOrgId: body.parent_org_id }        // undefined ⇒ "leave alone"
 *
 * `''` is falsy to the guard and defined to the write. Six write paths across
 * four files therefore skipped their ownership, existence and self-parent
 * checks and put `''` into a `ulid` column, whose CHECK answers 23514 — an
 * "Internal Server Error" on a request that had already walked past every rule
 * the route has. The SPA never met it because each of its call sites converts
 * the blank itself (`e.target.value || null`, `if (partner) query.set(…)`),
 * which is the server's rule living in the one client that happens to have it.
 *
 * So the rule is stated over the whole route table rather than fixed six times:
 * a field whose name ends in `_id` is `ulidField()`, or it is named below with
 * why it is not an id this platform mints.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/**
 * Fields named `*_id` that carry somebody else's identifier, not one of ours.
 *
 * Each is a string we store and hand back, never a ULID and never a key into
 * one of our own tables, so `ulidField()` would refuse the only values that
 * are ever correct. The value is the reason, so a future reader can tell an
 * exemption from an oversight.
 */
const NOT_OUR_IDS: Record<string, string> = {
  'adminSso.ts:idp_entity_id': 'SAML entity ID — a URI chosen by the identity provider',
  'adminSso.ts:sp_entity_id': 'SAML entity ID — a URI this deployment publishes',
  'capTableSync.ts:company_id': "the cap-table provider's own id for the company",
  'hris.ts:company_id': "the HRIS provider's own id for the company",
  'comments.ts:message_id': 'RFC 5322 Message-ID from the inbound email',
  'emailDelivery.ts:event_id': "the delivery provider's own id for the event",
  'partnerApi.ts:external_id': "the partner's own id for the engagement",
  'adminDocuments.ts:document_id':
    'deliberately case-lenient: upper-cased and then isUlid-filtered per assignment, ' +
    'so the batch reports "unknown document" per row rather than refusing the whole call',
};

interface IdField {
  file: string;
  line: number;
  field: string;
  expression: string;
}

/**
 * Every `<name>_id:` / `<name>_ids:` property in a route module, with the
 * head of the schema expression that follows it.
 *
 * Textual, like `finiteNumberSweep`: these are module-level constants across 90
 * route files, and importing them all to introspect `_def` would run every
 * module's side effects to check something the source already states.
 */
function idFields(): IdField[] {
  const found: IdField[] = [];
  for (const file of sourceFiles(ROUTES)) {
    const source = readFileSync(file, 'utf8');
    source.split('\n').forEach((text, i) => {
      const match = /^\s*([a-z][a-z0-9_]*_ids?)\s*:\s*(z\.|ulidField)(.*)$/.exec(text);
      if (!match) return;
      found.push({
        file: path.basename(file),
        line: i + 1,
        field: match[1]!,
        expression: (match[2]! + match[3]!).trim(),
      });
    });
  }
  return found;
}

describe('an id in a body or query string is validated as one', () => {
  it('finds the id fields it claims to scan', () => {
    // A sweep over an empty population passes vacuously. This is the floor:
    // the fields the round actually converted are more than a dozen.
    expect(idFields().length).toBeGreaterThan(20);
  });

  it('spells every one of ours `ulidField()`', () => {
    const offenders = idFields()
      .filter((f) => !f.expression.startsWith('ulidField'))
      // An array of ids is its own question — `workflow.ts` filters the bulk
      // list with `ids.filter(isUlid)` and reports each unknown id back to the
      // caller, which is a better answer than refusing the whole batch.
      .filter((f) => !f.expression.startsWith('z.array('))
      .filter((f) => !(`${f.file}:${f.field}` in NOT_OUR_IDS))
      .map((f) => `${f.file}:${f.line} ${f.field}: ${f.expression}`);
    expect(offenders).toEqual([]);
  });

  it('keeps no exemption for a field that no longer exists', () => {
    const present = new Set(idFields().map((f) => `${f.file}:${f.field}`));
    const stale = Object.keys(NOT_OUR_IDS).filter((key) => !present.has(key));
    expect(stale).toEqual([]);
  });
});

describe('domain/ulidField', () => {
  it('refuses the blank string that the truthiness guards read as absent', () => {
    expect(ulidField().safeParse('').success).toBe(false);
  });

  it('refuses a lower-cased or truncated id', () => {
    expect(ulidField().safeParse('01m1f3a9fpmehyqdze6gb9g0qt').success).toBe(false);
    expect(ulidField().safeParse('01M1F3A9FPMEHYQDZE6GB9G0Q').success).toBe(false);
  });

  it('accepts a ULID, and stays composable with the nullable/optional wrappers', () => {
    expect(ulidField().safeParse('01M1F3A9FPMEHYQDZE6GB9G0QT').success).toBe(true);
    const schema = z.object({ parent_id: ulidField().nullable().optional() });
    expect(schema.safeParse({ parent_id: null }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ parent_id: '' }).success).toBe(false);
  });
});
