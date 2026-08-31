import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOUSEKEEPING_TARGETS } from '../../src/domain/housekeeping.js';
import { RETENTION_DATA_TYPES } from '../../src/domain/retention.js';

/**
 * What personal data this platform holds, and what happens to it.
 *
 * There was no inventory. The nearest thing was `personalDataCensus.test.ts`,
 * which asks whether a subject access request would be *complete* — a
 * different question from what is held, how sensitive it is, and whether
 * anything ever removes it. This file is the inventory, derived from the
 * migrations rather than written beside them, and it states two rules over it.
 *
 * ## 1. The identifiers this schema does not hold
 *
 * A 409A platform has no need of a social security number, a taxpayer id, a
 * bank account or a date of birth — it values companies, and the natural
 * persons in the schema are named as *contacts*: an account holder, an option
 * grantee, a board member, someone who filled in the contact form. Every one
 * of them is a name, an address and sometimes a phone number.
 *
 * That is a fact worth pinning rather than assuming, because it is the answer
 * to "are the sensitive fields encrypted at rest" — there are none to encrypt,
 * and a review that takes that on trust is one migration away from being
 * wrong. `SPECIAL_CATEGORY` is the set of column shapes that would change the
 * answer. Adding one fails this test until somebody records how it is
 * protected: those identifiers are a different regulatory class (special
 * category / financial), and the decision about at-rest encryption has to be
 * made *before* the column exists, not discovered afterwards.
 *
 * The envelope is already here when it is needed — `crypto/envelope.ts`
 * AES-256-GCMs the TOTP secret, documents, and third-party OAuth tokens — so
 * the escape hatch is a real one, not a counsel of despair.
 *
 * ## 2. Every table holding contact details has a stated disposition
 *
 * Storage limitation is a rule about data nobody deletes, and this schema has
 * three separate mechanisms that might delete a row — the housekeeping sweep
 * (`domain/housekeeping.ts`), the retention policy engine
 * (`domain/retention.ts`), and `ON DELETE CASCADE` from the account or the
 * engagement — plus a fourth possibility, which is that nothing does. Which
 * applies to which table was written down nowhere, so "how long do we keep
 * this" had no answer per table and no answer overall.
 *
 * `DISPOSITION` records it, one line per table, and the census below refuses a
 * table it has never been told about. A `KEPT` disposition is allowed and is
 * the point: it makes an unbounded store a written decision instead of an
 * oversight, and it is what somebody would read out when asked.
 *
 * ## The other three places personal data appears
 *
 * This file is the *storage* axis, and on its own it answers a third of the
 * question. Three more surfaces carry the same data and each has its own guard,
 * named here so the set is findable from one place rather than by knowing to
 * look:
 *
 *  - **Log lines** — `packages/shared/test/logger.test.ts`. The redact list is
 *    field names, and the census there scans the services for any
 *    `*_email`/`*_phone`/`*_token`/`*_secret`/`*_password` property it has not
 *    been told about. The Python tier redacts free text by shape instead
 *    (`services/ai/app/observability.py`), because a formatted message has no
 *    field names to key off.
 *  - **Error bodies** — `errorBodyDisclosure.test.ts` and
 *    `upstreamErrorDisclosure.test.ts`: what a `detail` may repeat back, and
 *    what an upstream's wording may not carry through.
 *  - **API responses** — `adminUserDisclosure.test.ts`, on the resource where
 *    a row of this table is served. It derives the columns that must not go out
 *    from these same migrations, so a credential column added to `users`
 *    tomorrow is covered by it without an edit.
 *
 * `RETENTION_ENFORCEMENT` (domain/retention.ts, held by
 * `retentionEnforcement.test.ts`) is the fourth mechanism the dispositions
 * below can name, and the one that had been settable and unimplemented.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../migrations');

/**
 * Column shapes that would put this schema in a different regulatory class.
 *
 * Matched on the whole column name or a trailing/leading segment of it, so
 * `owner_ssn` and `ssn_last4` are both caught and `session_id` is not.
 */
const SPECIAL_CATEGORY: { label: string; pattern: RegExp }[] = [
  { label: 'social security number', pattern: /(^|_)ssn(_|$)|(^|_)social_security/ },
  { label: 'taxpayer identifier', pattern: /(^|_)(ein|tin|tax_id|taxpayer_id|vat_number)(_|$)/ },
  { label: 'bank details', pattern: /(^|_)(iban|bic|swift|routing_number|account_number|sort_code)(_|$)/ },
  { label: 'payment card', pattern: /(^|_)(card_number|pan|cvv|cvc)(_|$)/ },
  { label: 'government identity document', pattern: /(^|_)(passport|drivers_licen[cs]e|national_id)(_|$)/ },
  { label: 'date of birth', pattern: /(^|_)(dob|date_of_birth|birth_date|birthdate)(_|$)/ },
  { label: 'health or biometric', pattern: /(^|_)(health|biometric|ethnicit|religio)/ },
];

/**
 * Columns of a special-category shape that exist anyway, and how each is
 * protected at rest.
 *
 * Empty, and that emptiness is the finding: nothing in this schema is in that
 * class. An entry here must say what protects the value — `crypto/envelope.ts`
 * for something that must round-trip, a one-way hash for something only ever
 * compared — and why that treatment is the right one.
 */
const SPECIAL_CATEGORY_HELD: Record<string, string> = {};

type Disposition =
  | { how: 'housekeeping'; why: string }
  | { how: 'retention_policy'; dataType: string; why: string }
  | { how: 'cascade'; from: string; why: string }
  | { how: 'kept'; why: string };

/**
 * What removes each table's contact details, or the reason nothing does.
 *
 * The tables are derived below; this is the human half, and a table missing
 * from it fails the census rather than being assumed benign.
 */
const DISPOSITION: Record<string, Disposition> = {
  users: {
    how: 'kept',
    why:
      'The account itself. Closing it is a soft delete (`deleted_at`) rather than a purge, because a ' +
      "valuation's audit trail names who did what and a hard delete would falsify it. A person asking " +
      'for erasure is answered by the same route plus an operator purge, not by a sweep on a clock.',
  },
  user_invitations: {
    how: 'housekeeping',
    why: 'Settled invitations — accepted, revoked or lapsed — are swept 30 days after they stop meaning anything.',
  },
  email_verification_tokens: {
    how: 'housekeeping',
    why:
      'Spent verification tokens are swept 30 days after they are redeemed or expire. The address on ' +
      'the row is a copy of the one it was sent to, held so a since-changed email cannot be verified ' +
      'by an old link; it goes with the token.',
  },
  email_outbox: {
    how: 'retention_policy',
    dataType: 'email_outbox',
    why: 'Sent mail ages out under an operator-set policy; it is correspondence somebody may need to produce.',
  },
  notification_preferences: {
    how: 'cascade',
    from: 'users',
    why: 'Keyed on the account and cascaded from it — the row cannot outlive the account it is a setting of.',
  },
  email_suppressions: {
    how: 'kept',
    why:
      'A hard bounce or a complaint is kept until a human releases it. Ageing it out would restart ' +
      'sending to an address that told us to stop, which is the one outcome the table exists to ' +
      'prevent; the row is an address and a reason, and it is in the subject access export.',
  },
  contact_submissions: {
    how: 'kept',
    why:
      'Kept indefinitely, and nothing reaches it: it is not swept, no retention data type covers it, and ' +
      'its only foreign key is `handled_by`, so no cascade touches it either. This is the one unbounded ' +
      'store of contact details in the schema and it is recorded as a decision rather than left to be ' +
      'discovered — a marketing enquiry is correspondence operations may need to produce, and choosing ' +
      'a destruction schedule for it is a policy call for the business, not a default.',
  },
  valuation_events: {
    how: 'kept',
    why:
      'The engagement spine, and the only store in this schema with no erasure path at all: ' +
      "migration 0001's `valuation_events_immutable` trigger raises on UPDATE and on DELETE, with a " +
      'TRUNCATE twin beside it and no session flag, which is also why `DELETE FROM valuations` fails ' +
      'and why the retention engine declares `valuation` archive-only. It holds one contact detail ' +
      "on purpose — the address on `board_member_removed`, written as the deleted row's last record " +
      'of who was on the board — and that copy outlives the `board_signoffs` row it was taken from, ' +
      'so it is recorded here rather than left to be inferred from that table’s cascade disposition.',
  },
  admin_events: {
    how: 'kept',
    why:
      'The identity spine, labelled by address. Kept for the reason `RETENTION_ENFORCEMENT` gives for ' +
      '`audit_event`: it is what answers "who did this" about every other retention decision, including ' +
      'the ones that delete things, so a policy able to age it out would be the one setting able to ' +
      'erase the evidence that it ran. The consequence is recorded rather than assumed — a failed login ' +
      'writes the address it was attempted against whether or not an account exists behind it, so this ' +
      'holds addresses of people who are not users and cannot ask for them.',
  },
  option_grants: {
    how: 'cascade',
    from: 'valuations',
    why:
      "A grantee named on a client company's cap table. Cascaded from the engagement, so it goes when " +
      'the engagement is purged under the valuation retention policy.',
  },
  board_signoffs: {
    how: 'cascade',
    from: 'valuations',
    why: "A director named on a client's board resolution; cascaded from the engagement and from the resolution.",
  },
  client_intake_links: {
    how: 'cascade',
    from: 'partners',
    why:
      "The contact a firm addressed an intake link to. Cascaded from the partner; the link's own " +
      'valuation reference is `ON DELETE SET NULL` because a link may be issued before the engagement exists.',
  },
};

/** Every table's columns, parsed from `CREATE TABLE` and `ALTER TABLE … ADD COLUMN`. */
export function tableColumns(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    const key = table.replace(/"/g, '').replace(/^public\./, '');
    if (!found.has(key)) found.set(key, new Set());
    found.get(key)!.add(column.toLowerCase());
  };
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
    let m: RegExpExecArray | null;
    while ((m = create.exec(sql))) {
      for (const line of m[2]!.split('\n')) {
        const col = /^\s*([a-z0-9_]+)\s+[a-z]/i.exec(line);
        if (col && !/^(primary|unique|constraint|check|foreign)$/i.test(col[1]!)) add(m[1]!, col[1]!);
      }
    }
    const alter =
      /alter\s+table\s+(?:if\s+exists\s+)?([a-z0-9_."]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi;
    while ((m = alter.exec(sql))) add(m[1]!, m[2]!);
  }
  return found;
}

/** `*_email` names that are not a natural person's address — see logger.ts. */
const NON_PERSONAL_CONTACT = new Set(['marketing_email', 'support_email', 'auto_email']);
const CONTACT_COLUMN = /(^|_)(email|phone)$/;

const columns = tableColumns();
const namedContactTables = [...columns.entries()]
  .filter(([, cols]) => [...cols].some((c) => CONTACT_COLUMN.test(c) && !NON_PERSONAL_CONTACT.has(c)))
  .map(([table]) => table)
  .sort();

/**
 * The second half: a column that holds an address under a name that does not
 * say so.
 *
 * `CONTACT_COLUMN` derives the whole inventory from column *names*, which is
 * the one direction it fails in — and it is the same failure
 * `loggedFieldRenames.test.ts` was written for on the log sites, one layer
 * down. There, "the redact list protects a key, and the log site can rename
 * it"; here, the inventory protects a column, and the write site can rename it.
 * `personalDataCensus` learned the equivalent lesson in R159 about tables
 * ("every table that is about a person" meant "every table with a foreign
 * key"), and this is the column-level version of it.
 *
 * `admin_events.subject_label` is the column. Twenty-odd sites write a user's
 * address into it — every authentication event, every SCIM and SAML
 * provisioning event, every account change — and one of them is on an
 * *unauthenticated* route, writing the address a failed login was attempted
 * against whether or not an account exists behind it. Nothing about the name
 * `subject_label` says any of that, so the table was outside this inventory
 * entirely while being one of the largest stores of addresses in the schema
 * and one nothing ever removes.
 *
 * Derived from the writers rather than declared, so the next renamed sink fails
 * here: the scan finds every object property whose value is an address-shaped
 * expression and whose key is not itself contact-shaped, and every key it finds
 * has to be accounted for below — as a column of a named table, which then owes
 * a disposition, or as a destination that is not a column at all, with a
 * reason.
 */
const SERVICE_SRC = path.resolve(HERE, '../../src');

/** Sources with comments and string literals blanked, line structure kept. */
function code(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/([^:"'`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + blank(m.slice(1)))
    .replace(/'[^'\n]*'|"[^"\n]*"/g, blank);
}

function serviceSources(dir: string = SERVICE_SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...serviceSources(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * `key: <address expression>` where the key does not say "address".
 *
 * The bare `email`/`phone` identifier is required not to be followed by a dot,
 * because `email` names the *outbox row* in this codebase at least as often as
 * it names an address — `body: email.body` is not a disclosure, and counting it
 * would bury the ones that are.
 */
const ADDRESS_SINK =
  /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_.?]*\.(?:email|phone)\b(?!\.)|(?:email|phone)\b(?!\.))/g;

function addressSinks(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of serviceSources()) {
    code(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(ADDRESS_SINK)) {
          const key = m[1]!;
          if (/email|phone|address|recipient/i.test(key) || key === 'to') continue;
          if (!found.has(key)) found.set(key, []);
          found.get(key)!.push(`${path.relative(SERVICE_SRC, file)}:${i + 1}`);
        }
      });
  }
  return found;
}

/**
 * Where each renamed address sink ends up. `table` names the table the value is
 * stored in — which then owes a disposition like any other contact-bearing
 * table — or is null for a destination that is not a column, with the reason.
 */
const ADDRESS_SINKS: Record<string, { table: string | null; why: string }> = {
  subjectLabel: {
    table: 'admin_events',
    why: '`recordAdminEvent`’s label column: the identity spine, stored and kept.',
  },
  label: {
    table: 'admin_events',
    why: 'The billing routes’ own wrapper around `recordAdminEvent`, forwarded to `subjectLabel`.',
  },
  userName: {
    table: null,
    why:
      "SCIM's wire shape, not a column: RFC 7643 makes `userName` the unique identifier of a provisioned " +
      'user and every IdP sends the address in it. Served to the employer’s own IdP over a token-scoped ' +
      'route, which is where the address came from.',
  },
  value: {
    table: null,
    why: 'The element of SCIM’s `emails: [{ value }]` array — the same response shape, one level in.',
  },
  reminded: {
    table: null,
    why:
      'A field of the ops-only `remind-documents` response, echoing which address the reminder went to. ' +
      'The route is refused to anyone but operations, and the reader is the person who pressed the ' +
      'button.',
  },
};

/**
 * The third half: an address written under a contact-shaped name into
 * something that is not a column.
 *
 * The two scans above divide the problem between them and leave a gap exactly
 * where they meet. `namedContactTables` derives the inventory from *columns*
 * whose name says "address", so it cannot see a value that never becomes a
 * column. `ADDRESS_SINKS` derives it from *keys* whose name does not say
 * "address" — and its first act is to skip every key that matches
 * `/email|phone|address|recipient/i`, because a key that says so is assumed to
 * be a column already covered by the first scan.
 *
 * A key called `member_email` inside a JSONB payload is in neither. It is not
 * a column, so the first scan is blind to it; it is honestly named, so the
 * second scan skips it. Four sites sat in that gap, and the table they wrote
 * to is the worst one in the schema to have missed: `valuation_events` carries
 * `valuation_events_immutable` from migration 0001, a `BEFORE UPDATE OR DELETE`
 * trigger whose whole body is `RAISE EXCEPTION`, with a `BEFORE TRUNCATE` twin
 * beside it and no session flag to disable either. A row written there cannot
 * be edited or removed by anything — not the retention engine, which declares
 * `valuation` archive-only for reasons of its own; not a cascade, because
 * `DELETE FROM valuations` is itself blocked by this trigger; not
 * `DELETE /api/v1/me`, which soft-deletes the account. It is the one store in
 * this schema with no erasure path at all, and the two inventories that exist
 * to find unbounded stores of contact details could not see into it.
 *
 * That matters most where a disposition elsewhere reads as covering it.
 * `board_signoffs` is declared `cascade from valuations` — "it goes when the
 * engagement is purged" — and `deleteBoardMember` does delete the row; the copy
 * of the address in the payload of the event recording that deletion does not
 * go anywhere, ever. The disposition was true of the row and false of the copy.
 *
 * Declared rather than banned, for the same reason `admin_events` is: this is
 * the audit spine, and there is one act on it whose whole content is a person's
 * identity. What the census enforces is that each such key is a decision
 * somebody wrote down, and that the table it lands in owes a disposition like
 * any other.
 */
const PAYLOAD_CONTACT_SINKS: Record<string, { table: string | null; why: string }> = {
  member_email: {
    table: 'valuation_events',
    why:
      '`board_member_removed`, written in the transaction that deletes the `board_signoffs` row: ' +
      'after it, `signoff_id` resolves to nothing, and "some member was removed from the resolution ' +
      'adopting this FMV" is not an answer to the question the trail exists for. The other two board ' +
      'events name the live row instead.',
  },
};

/**
 * Contact-shaped keys inside an event `payload:` object literal.
 *
 * Read from `code()`-blanked sources, so a key named in a comment or inside a
 * string is not a write site, and brace-matched from the literal's own opening
 * brace so a nested object belongs to the payload it is nested in.
 */
function payloadContactKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of serviceSources()) {
    const src = code(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/payload\s*:\s*\{/g)) {
      const open = src.indexOf('{', m.index!);
      let depth = 0;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
          depth -= 1;
          if (depth > 0) continue;
          const body = src.slice(open, i + 1);
          for (const k of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
            const key = k[1]!;
            if (!CONTACT_COLUMN.test(key) || NON_PERSONAL_CONTACT.has(key)) continue;
            const line = src.slice(0, open + (k.index ?? 0)).split('\n').length;
            if (!found.has(key)) found.set(key, []);
            found.get(key)!.push(`${path.relative(SERVICE_SRC, file)}:${line}`);
          }
          break;
        }
      }
    }
  }
  return found;
}

const payloadContactTables = [
  ...new Set(
    Object.values(PAYLOAD_CONTACT_SINKS)
      .map((s) => s.table)
      .filter((t): t is string => t !== null),
  ),
].sort();

const renamedContactTables = [
  ...new Set(
    Object.values(ADDRESS_SINKS)
      .map((s) => s.table)
      .filter((t): t is string => t !== null),
  ),
].sort();

const contactTables = [
  ...new Set([...namedContactTables, ...renamedContactTables, ...payloadContactTables]),
].sort();

describe('the personal data inventory', () => {
  it('parses a schema at all', () => {
    // Vacuity guard. "No special-category column exists" is exactly the
    // assertion an empty parse makes loudest, and it would be believed.
    expect(columns.size).toBeGreaterThan(80);
    expect(columns.get('users')).toContain('email');
    expect(contactTables.length).toBeGreaterThan(5);
  });

  it('recognises a special-category column when it sees one', () => {
    // The other half of the guard: the patterns are what the check is, so they
    // are exercised against names rather than trusted.
    const hit = (name: string) => SPECIAL_CATEGORY.some((c) => c.pattern.test(name));
    for (const name of ['ssn', 'owner_ssn', 'ssn_last4', 'tax_id', 'routing_number', 'date_of_birth'])
      expect(hit(name), name).toBe(true);
    // …and does not fire on the ordinary columns this schema is full of.
    for (const name of ['session_epoch', 'account_id', 'panel_id', 'created_at', 'valuation_id'])
      expect(hit(name), name).toBe(false);
  });

  it('holds no special-category identifier, or says how each is protected', () => {
    const found: string[] = [];
    for (const [table, cols] of columns)
      for (const col of cols)
        for (const { label, pattern } of SPECIAL_CATEGORY)
          if (pattern.test(col) && !(`${table}.${col}` in SPECIAL_CATEGORY_HELD))
            found.push(`${table}.${col} (${label})`);
    // A column of this shape is a regulatory decision, not a migration. Either
    // it does not belong here, or it belongs in SPECIAL_CATEGORY_HELD with the
    // treatment that protects it at rest — see crypto/envelope.ts.
    expect(found.sort(), 'special-category identifiers with no recorded protection').toEqual([]);
  });

  it('keeps no protection note for a column that is not there', () => {
    const stale = Object.keys(SPECIAL_CATEGORY_HELD).filter((key) => {
      const [table, col] = key.split('.');
      return !columns.get(table!)?.has(col!);
    });
    expect(stale).toEqual([]);
  });

  it('gives every table holding contact details a disposition', () => {
    const undeclared = contactTables.filter((t) => !(t in DISPOSITION));
    // "How long do we keep this" is a question per table, and a table nobody
    // answered it for is the answer "forever, by accident".
    expect(undeclared, 'tables holding a person’s contact details with no stated disposition').toEqual([]);
  });

  it('keeps no disposition for a table that holds no contact details', () => {
    expect(
      Object.keys(DISPOSITION)
        .filter((t) => !contactTables.includes(t))
        .sort(),
    ).toEqual([]);
  });

  it('names a real mechanism in every disposition', () => {
    // The registry is only worth keeping if its claims are checkable. A
    // `housekeeping` claim must match a sweep target, and a `retention_policy`
    // claim must name a data type the engine knows.
    const swept = new Set(HOUSEKEEPING_TARGETS.map((t) => t.table));
    for (const [table, d] of Object.entries(DISPOSITION)) {
      if (d.how === 'housekeeping') expect(swept, `${table} claims a sweep`).toContain(table);
      if (d.how === 'retention_policy')
        expect(RETENTION_DATA_TYPES as readonly string[], `${table} claims a policy`).toContain(d.dataType);
      if (d.how === 'cascade') expect(columns.has(d.from), `${table} cascades from ${d.from}`).toBe(true);
    }
  });

  it('gives every disposition a reason somebody could read out', () => {
    const thin = Object.entries(DISPOSITION).filter(([, d]) => d.why.trim().length < 80);
    expect(thin.map(([t]) => t)).toEqual([]);
  });

  it('records every table nothing removes as a decision', () => {
    // Stated positively so it cannot be lost in a diff: these are the schema's
    // unbounded stores of contact details, and if the set changes in either
    // direction this says so. `admin_events` joined it when the derivation
    // below learned to see a renamed column — it had been unbounded and
    // unrecorded the whole time.
    const kept = Object.entries(DISPOSITION)
      .filter(([, d]) => d.how === 'kept')
      .map(([t]) => t)
      .sort();
    expect(kept).toEqual([
      'admin_events',
      'contact_submissions',
      'email_suppressions',
      'users',
      'valuation_events',
    ]);
  });
});

describe('the contact details that never become a column', () => {
  const sinks = payloadContactKeys();

  it('finds the payload write sites at all — the vacuity guard', () => {
    // Without this, a regex that stopped matching would make the check below
    // pass over an empty map, which is exactly how this gap survived two
    // inventories: a scan that finds nothing and a schema that holds nothing
    // are indistinguishable from the outside.
    const literals = serviceSources()
      .map((f) => [...code(readFileSync(f, 'utf8')).matchAll(/payload\s*:\s*\{/g)].length)
      .reduce((a, b) => a + b, 0);
    expect(literals).toBeGreaterThan(30);
    expect(sinks.get('member_email')?.length ?? 0).toBe(1);
  });

  it('accounts for every contact detail written into an event payload', () => {
    const undeclared = [...sinks.keys()].filter((key) => !(key in PAYLOAD_CONTACT_SINKS)).sort();
    // A JSONB payload is not a column, so neither inventory above can see this.
    // A new key here is a decision: the address goes into a table whose rows
    // this schema has no mechanism to remove, so either the id will do — which
    // it did at three of the four sites that were here — or the reason it will
    // not belongs beside it.
    expect(undeclared, 'contact details written into an event payload with no stated reason').toEqual([]);
  });

  it('keeps no declaration for a payload key nothing writes', () => {
    const stale = Object.keys(PAYLOAD_CONTACT_SINKS).filter((key) => !sinks.has(key));
    expect(stale, 'declared payload contact keys with no write site').toEqual([]);
  });

  it('pins the immutability that makes these copies permanent', () => {
    // The claim the disposition rests on, read from the migration rather than
    // repeated from a comment: if the trigger is ever relaxed, the reason
    // `valuation_events` is `kept` changes and this says so.
    const sql = readFileSync(path.join(MIGRATIONS, '0001_core.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TRIGGER valuation_events_immutable\s+BEFORE UPDATE OR DELETE ON valuation_events/);
  });
});

describe('the columns that hold an address under another name', () => {
  const sinks = addressSinks();

  it('finds the write sites at all — the vacuity guard', () => {
    // Without this, a regex that stopped matching would make every check below
    // pass against an empty map, and the inventory would read as complete for
    // the same reason it was incomplete before: nobody asked the column what it
    // held.
    const sites = [...sinks.values()].flat();
    expect(sites.length).toBeGreaterThanOrEqual(20);
    expect(sinks.get('subjectLabel')?.length ?? 0).toBeGreaterThanOrEqual(15);
  });

  it('accounts for every key an address is written under', () => {
    const undeclared = [...sinks.keys()].filter((key) => !(key in ADDRESS_SINKS)).sort();
    // A new one is a decision: either it is a column, and the table it belongs
    // to owes a disposition, or it is not, and the reason belongs beside it.
    expect(undeclared, 'object keys carrying an address that nothing has classified').toEqual([]);
  });

  it('keeps no entry for a sink that no longer exists', () => {
    expect(
      Object.keys(ADDRESS_SINKS)
        .filter((key) => !sinks.has(key))
        .sort(),
    ).toEqual([]);
  });

  it('gives every renamed sink a reason, and every named table a disposition', () => {
    for (const [key, sink] of Object.entries(ADDRESS_SINKS)) {
      expect(sink.why.trim().length, key).toBeGreaterThan(40);
      if (sink.table !== null) {
        expect(columns.has(sink.table), `${key} names a table that is not in the schema`).toBe(true);
        expect(DISPOSITION[sink.table], `${sink.table} holds addresses and has no disposition`).toBeDefined();
      }
    }
  });

  it('is the reason `admin_events` is in the inventory at all', () => {
    // The founding case, pinned so the derivation cannot quietly stop covering
    // it: nothing about the *name* `subject_label` is address-shaped, so the
    // name-based half above cannot see this table and never could.
    expect(namedContactTables).not.toContain('admin_events');
    expect(contactTables).toContain('admin_events');
  });
});
