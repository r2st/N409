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

/**
 * Arrays of ids the route sorts out for itself, and why that is the better
 * answer than refusing the request.
 *
 * A blanket `z.array(` skip used to stand here, which exempted *every* array
 * of ids on the strength of what one of them does. Two did earn it — the bulk
 * executor and the re-run queue both `filter(isUlid)` and report each id they
 * could not act on, so refusing the whole batch over one bad row would be
 * worse for the operator holding the spreadsheet. Two did not: the anonymizer's
 * `document_ids` and the dead-letter replay's `ids` went straight to
 * `id = ANY($1)` over a `ulid` column, so one malformed entry answered 500 for
 * the whole call. Those are `z.array(ulidField())` now.
 */
const FILTERED_ID_ARRAYS: Record<string, string> = {
  'workflow.ts:ids': 'the legacy bulk shape; `dedupeIds` + `filter(isUlid)`, reported per id',
  'workflow.ts:valuation_ids': 'the bulk-action shape, normalized into the same executor',
  'dataRemediation.ts:valuation_ids':
    'the re-run queue; each id is answered with why it was not re-run, which a 422 cannot say',
};

interface IdField {
  file: string;
  line: number;
  field: string;
  expression: string;
}

/**
 * Every `id:` / `<name>_id:` / `<name>_ids:` property in a route module, with
 * the head of the schema expression that follows it.
 *
 * Textual, like `finiteNumberSweep`: these are module-level constants across 90
 * route files, and importing them all to introspect `_def` would run every
 * module's side effects to check something the source already states.
 *
 * ## Not anchored to the start of a line (round 333)
 *
 * The first version of this matched `/^\s*(…)/`, which reads every field a
 * multi-line `z.object({` declares — and none of the ones written on a single
 * line:
 *
 *     const PartnerQuery = z.object({ partner_id: z.string().optional() });
 *
 * That is not a rare spelling. It is what a one-field schema looks like in this
 * codebase, and nine fields were written that way — including the three
 * `partner_id` query filters (`firm.ts`, `clientIntake.ts`, `branding.ts`) that
 * decide which tenant a console is about. Each admitted any string there is and
 * carried it to a `ulid` column, whose domain CHECK answers 23514 — the same
 * "Internal Server Error past every rule the route has" R331 closed for the
 * fields it *could* see. A census whose population is a formatting choice
 * reports a clean sweep of the half it happened to look at.
 *
 * `id`/`ids` with no prefix are in the name pattern for the same reason: the
 * bulk executor's list is spelled `ids`, and the dead-letter replay's is too.
 * Response objects are not swept up by widening it, because the value still has
 * to begin with `z.` or `ulidField` to be a schema at all.
 */
/**
 * `UlidParam` is in the lookahead beside `z.` and `ulidField` because
 * `valuations.ts` spells its two query ids that way — the params plugin's own
 * ULID schema, reused. It is a correct spelling, and a matcher that only knows
 * literals cannot say so: the field was simply not in the population, which is
 * the same silence as an unvalidated one.
 */
const ID_FIELD = /(?:^|[{,(\s])((?:[a-z][a-z0-9_]*_)?ids?)\s*:\s*(?=z\.|ulidField|UlidParam)/g;

/** Every id-shaped schema field on one line — a one-line object can declare several. */
export function idFieldsOn(text: string): Array<{ field: string; expression: string }> {
  return [...text.matchAll(ID_FIELD)].map((m) => ({
    field: m[1]!,
    expression: text.slice(m.index! + m[0]!.length).trim(),
  }));
}

function idFields(): IdField[] {
  const found: IdField[] = [];
  for (const file of sourceFiles(ROUTES)) {
    const source = readFileSync(file, 'utf8');
    source.split('\n').forEach((text, i) => {
      for (const { field, expression } of idFieldsOn(text)) {
        found.push({ file: path.basename(file), line: i + 1, field, expression });
      }
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

  it('reads a field declared inline in a one-line schema', () => {
    // The blind spot round 333 closed, pinned as a property of the matcher
    // rather than only as the absence of offenders: without this the census
    // passes on a file it never looked inside.
    expect(idFieldsOn('const Q = z.object({ partner_id: z.string().optional() });')).toEqual([
      { field: 'partner_id', expression: 'z.string().optional() });' },
    ]);
    // And every field on the line, not merely the first.
    expect(
      idFieldsOn('z.object({ valuation_id: ulidField(), analyst_id: ulidField() })').map((f) => f.field),
    ).toEqual(['valuation_id', 'analyst_id']);
    // A response object is not a schema, and widening the name pattern to bare
    // `id`/`ids` must not start reading one.
    expect(idFieldsOn('return { id: row.id, valuation_id: row.valuation_id };')).toEqual([]);
  });

  it('spells every one of ours `ulidField()`', () => {
    const offenders = idFields()
      // `z.array(ulidField())` is the plural spelling of the same rule.
      .filter((f) => !/^(?:ulidField|UlidParam|z\.array\(ulidField)/.test(f.expression))
      .filter((f) => !(`${f.file}:${f.field}` in FILTERED_ID_ARRAYS))
      .filter((f) => !(`${f.file}:${f.field}` in NOT_OUR_IDS))
      .map((f) => `${f.file}:${f.line} ${f.field}: ${f.expression}`);
    expect(offenders).toEqual([]);
  });

  it('keeps no exemption for a field that no longer exists', () => {
    const present = new Set(idFields().map((f) => `${f.file}:${f.field}`));
    const stale = [...Object.keys(NOT_OUR_IDS), ...Object.keys(FILTERED_ID_ARRAYS)].filter(
      (key) => !present.has(key),
    );
    expect(stale).toEqual([]);
  });

  it('holds every exempt array to the filter that earns the exemption', () => {
    // The exemption is "this route sorts the ids out itself and reports each
    // one back". That is a claim about the handler, so it is checked against
    // the handler: an array field allowed to be `z.string()` whose file has
    // stopped calling `isUlid` is an exemption that no longer describes
    // anything, and the blanket `z.array(` skip this replaced could not tell.
    const unfiltered = Object.keys(FILTERED_ID_ARRAYS).filter((key) => {
      const file = key.split(':')[0]!;
      return !readFileSync(path.join(ROUTES, file), 'utf8').includes('isUlid');
    });
    expect(unfiltered).toEqual([]);
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
