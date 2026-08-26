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
const contactTables = [...columns.entries()]
  .filter(([, cols]) => [...cols].some((c) => CONTACT_COLUMN.test(c) && !NON_PERSONAL_CONTACT.has(c)))
  .map(([table]) => table)
  .sort();

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

  it('records the one table nothing removes as a decision', () => {
    // Stated positively so it cannot be lost in a diff. `contact_submissions`
    // is the only unbounded store of contact details in the schema; if that
    // ever stops being true in either direction, this says so.
    const kept = Object.entries(DISPOSITION)
      .filter(([, d]) => d.how === 'kept')
      .map(([t]) => t)
      .sort();
    expect(kept).toEqual(['contact_submissions', 'email_suppressions', 'users']);
  });
});
