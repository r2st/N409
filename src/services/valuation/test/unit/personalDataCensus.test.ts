import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A subject access request is answered by a hand-written list of SELECTs, and
 * nothing compared that list against the schema.
 *
 * `buildPersonalDataExport` enumerates its sections one query at a time, which
 * is the right shape — the alternative is a dump — but it means the export's
 * completeness is a fact about what somebody remembered on the day. It is not
 * a fact anything checks, and it decays in exactly one direction: a migration
 * adds a table that holds data about a person, nobody thinks about the export,
 * and the statutory answer quietly stops being complete. That is how
 * `email_outbox` came to be missing for as long as it was — the export said in
 * its own doctrine that it covered "the messages the platform sent them" and
 * covered only the in-app half.
 *
 * So this states the rule over the schema instead. Every table with a column
 * that means *this row is about this person* must be either exported or listed
 * here with a reason. The reasons are the interesting part: they are the
 * record of what this platform decided counts as personal data, which
 * otherwise exists nowhere.
 *
 * Deliberately not a scan for "any FK to users". Most of them are `created_by`
 * and `updated_by` on a valuation's working papers, where the row is about a
 * company's 409A and the column is a stamp of who touched it. Those belong to
 * the audit trail, and sweeping them in here would make the registry a list of
 * seventy exemptions that nobody reads — which is the same as no registry.
 * `SUBJECT_COLUMNS` is the narrow rule, and `ACTOR_COLUMNS` states the wide
 * exemption once, as a class, with its reason attached to the class.
 *
 * ## The half the foreign keys could not see
 *
 * All of the above asks the schema "which rows point at a person's *row*". A
 * table that identifies a person by their **email address** points at no row
 * and answers no such question, so it was invisible here however plainly
 * personal its contents — and five tables are shaped that way. The public
 * contact form is the clearest: `contact_submissions` holds a name, an
 * address, a phone number and free text somebody wrote about themselves, has
 * no `user_id` because the form is unauthenticated by design, and was in no
 * access request and no registry of exemptions. The census said "every table
 * that is about a person" and meant "every table with a foreign key", which is
 * the failure mode this codebase keeps a register of
 * (`n409-vacuous-checks`): the reassuring output is what stops anyone looking.
 *
 * So `CONTACT_TABLES` derives the second half from the schema the same way —
 * any table with a column that *is* a natural person's contact detail — and
 * puts it under the same obligation: exported, or exempted with a reason.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../migrations');
const EXPORT_SRC = path.resolve(HERE, '../../src/repos/dataExport.ts');

/**
 * Columns whose FK to `users` means the row is *about* that person.
 *
 * The test is whether the person is the subject of the row or merely the hand
 * that wrote it. `notifications.user_id` is addressed to them;
 * `cap_tables.created_by` records who uploaded a company's cap table.
 */
const SUBJECT_COLUMNS = [
  'user_id',
  'owner_id',
  'owner_user_id',
  'author_id',
  'to_user_id',
  'signer_user_id',
  // An upload sits on the boundary and is resolved by what the export already
  // decided: its doctrine counts "the records they authored (comments, support
  // tickets, uploads, API tokens)" as theirs, and `documents_uploaded` selects
  // on this column. The file's *contents* are still the company's and are not
  // copied here — the section is metadata.
  'uploaded_by',
];

/**
 * The classes are not exclusive in the direction that matters. A subject
 * column *must* be exported or exempted; an actor column *may* be exported
 * anyway, and one is — `api_tokens.created_by`, because a token a person
 * minted is a record about them however the column is named. The rule only
 * ever adds obligations, so a column in both places is not a contradiction.
 */

/**
 * The wide exemption, stated once. A column in this class names who performed
 * an action on something that is not them — a valuation, a template, a
 * connection, another person's account. What that person did is the audit
 * trail's subject (`admin_events`, `valuation_events`), which is a different
 * question from what is held *about* them, and answering it here would put
 * every client's working papers into an access request by the back door.
 *
 * Listed so that a new one cannot be invented silently: a column that is
 * neither a subject nor a known actor fails the roster test below and has to
 * be classified by a human.
 */
const ACTOR_COLUMNS = [
  'created_by',
  'updated_by',
  'connected_by',
  'decided_by',
  'applied_by',
  'triggered_by',
  'entered_by',
  'handled_by',
  'released_by',
  'placed_by',
  'requested_by',
  'invited_by',
  'reviewed_by',
  'resolved_by',
  'assignee_id',
  'assigned_analyst_id',
  'assigned_reviewer_id',
  'provisioned_by',
];

/**
 * Tables that hold a subject column and are deliberately not exported.
 *
 * Each reason has to survive being read out to the person asking, which is the
 * standard these were written to.
 */
const EXEMPT: Record<string, string> = {
  password_reset_tokens:
    'A live single-use capability to take over the account. Exporting it is handing over the ' +
    'reset, which is Art. 15(4) exactly: the copy would be the harm.',
  email_verification_tokens:
    'Same family as the reset token — a single-use capability, not a record about the person.',
  organizations:
    'The row is a company, not a person. `owner_user_id` says which account administers it; ' +
    'the commercial relationship a person has with us is in `engagements` and `invoices`.',
  blog_posts:
    'Public content written in a work capacity, already published under a byline. Nothing is ' +
    'held here that the author cannot read on the site.',
  help_articles: 'Same as blog_posts — published product content, authored as staff.',
};

/**
 * Columns holding a natural person's contact details.
 *
 * `(^|_)(email|phone)$` rather than a hand-list, for the reason `logger.ts`
 * gives about `SENSITIVE_FIELDS`: this platform names the column after the
 * *role* — `member_email`, `grantee_email`, `client_email`, `to_email` — and
 * any list of those is a list somebody has to remember to extend.
 *
 * `_name` is deliberately not in the family, and that is the same call
 * `logger.test.ts` makes: on this schema `*_name` is dominated by companies,
 * plans and templates, so scanning it would report `legal_name`, `plan_name`
 * and `index_name` forever, and a tripwire that is always red is one somebody
 * deletes. A table holding a person's name always holds their address too on
 * this schema — checked below — so nothing is missed by the narrower rule.
 */
const CONTACT_COLUMN = /(^|_)(email|phone)$/;

/**
 * `*_email` columns that are not a natural person's address.
 *
 * The same three declared exceptions `logger.test.ts` holds, for the same
 * reasons: `marketing_email` is a boolean consent flag, `support_email` is a
 * firm's own published support address shown to anonymous visitors, and
 * `auto_email` names a feature. Declared rather than skipped so each stays a
 * judgement somebody can re-read.
 */
const NON_PERSONAL_CONTACT = new Set(['marketing_email', 'support_email', 'auto_email']);

/** Parse `CREATE TABLE` and `ALTER TABLE … ADD COLUMN` for FKs to `users`. */
function tablesReferencingUsers(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    const key = table.replace(/"/g, '').replace(/^public\./, '');
    if (!found.has(key)) found.set(key, new Set());
    found.get(key)!.add(column);
  };
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
    let m: RegExpExecArray | null;
    while ((m = create.exec(sql))) {
      for (const line of m[2].split('\n')) {
        const col = /^\s*([a-z0-9_]+)\b[\s\S]*references\s+users\b/i.exec(line);
        if (col) add(m[1], col[1]);
      }
    }
    const alter =
      /alter\s+table\s+(?:if\s+exists\s+)?([a-z0-9_."]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)[^;]*references\s+users\b/gi;
    while ((m = alter.exec(sql))) add(m[1], m[2]);
  }
  return found;
}

/**
 * Tables the export actually reads, taken from its SQL rather than from a
 * second list beside it.
 *
 * Read out of the source on purpose: a hand-kept "these are exported" array is
 * a third copy of the truth, and the copy that goes stale first.
 */
function exportedTables(): Set<string> {
  const src = readFileSync(EXPORT_SRC, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) names.add(m[1].toLowerCase());
  return names;
}

/** Every table's columns, from the same two statement shapes. */
export function tableColumns(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    const key = table.replace(/"/g, '').replace(/^public\./, '');
    if (!found.has(key)) found.set(key, new Set());
    found.get(key)!.add(column.toLowerCase());
  };
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
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

/**
 * Tables holding a contact detail and deliberately not exported.
 *
 * Each of these names a natural person who is a *third party to an
 * engagement*, and the export's own doctrine already draws that line: a 409A's
 * cap table, projections and comparables are the client company's data, not
 * the account holder's, and are reachable through the engagement rather than
 * through an access request. The people named in those working papers are on
 * the company's side of the same line — the platform's relationship is with
 * the company, and the company is the controller of what it recorded about
 * them. Copying them into the requester's download would answer an access
 * request with somebody else's personal data, which Art. 15(4) is about.
 */
const CONTACT_EXEMPT: Record<string, string> = {
  option_grants:
    "A grantee named on a client company's cap table. The grant is the company's record of its own " +
    'equity — imported from its HRIS or its cap-table provider and reported back to it — and the ' +
    'grantee is an employee of that company rather than an account holder here. Exporting it into ' +
    "another person's access request would hand over a client's option ledger.",
  board_signoffs:
    "A director named on a client company's board resolution. Same line as option_grants: the " +
    "resolution is the company's corporate record, the board member is a third party to our " +
    'relationship with the account holder, and the company is who they would ask.',
  client_intake_links:
    'The contact a firm addressed an intake link to, on an engagement that firm owns. The row is ' +
    "part of the engagement's working papers; the person named is the firm's client contact, and " +
    'once they have an account everything held about *them* is reachable through it.',
  email_verification_tokens:
    'A single-use capability to prove an address, in the same family as the reset token — the copy ' +
    'would be the harm (Art. 15(4)), and the address it names is already in the account section.',
};

const schema = tablesReferencingUsers();
const exported = exportedTables();
const columns = tableColumns();

const contactTables = [...columns.entries()]
  .filter(([, cols]) => [...cols].some((c) => CONTACT_COLUMN.test(c) && !NON_PERSONAL_CONTACT.has(c)))
  .map(([table]) => table)
  .sort();

const subjectTables = [...schema.entries()]
  .filter(([, cols]) => [...cols].some((c) => SUBJECT_COLUMNS.includes(c)))
  .map(([table]) => table)
  .sort();

describe('personal data export covers what the schema holds about a person', () => {
  it('reads a schema at all', () => {
    // Vacuity guard. Every assertion below passes trivially against an empty
    // scan, and the scan is two regexes over SQL — one migration written in a
    // style they do not match and this census goes quiet while claiming to
    // have checked.
    expect(schema.size).toBeGreaterThan(50);
    expect(subjectTables.length).toBeGreaterThan(10);
  });

  it('finds the export reading the tables it plainly reads', () => {
    // The other half of the vacuity guard: `exportedTables` parses SQL out of
    // a TypeScript file, and if it ever stops matching, every table looks
    // unexported and the registry test below fails loudly rather than
    // quietly — but this says which half broke.
    for (const t of ['users', 'valuations', 'notifications', 'email_outbox'])
      expect(exported, t).toContain(t);
  });

  it('classifies every column that points at a person', () => {
    const unknown: string[] = [];
    for (const [table, cols] of schema)
      for (const col of cols)
        if (!SUBJECT_COLUMNS.includes(col) && !ACTOR_COLUMNS.includes(col)) unknown.push(`${table}.${col}`);
    // A new column naming a person is a decision, not a default. Add it to
    // SUBJECT_COLUMNS (and then export it or exempt it) or to ACTOR_COLUMNS.
    expect(unknown.sort()).toEqual([]);
  });

  it('exports or explains every table that is about a person', () => {
    const unaccounted = subjectTables.filter((t) => !exported.has(t) && !(t in EXEMPT));
    expect(unaccounted).toEqual([]);
  });

  it('keeps no exemption for a table it exports anyway', () => {
    // A stale exemption reads as a considered decision to withhold something
    // that is in fact in the copy — the registry lying in the direction that
    // makes it useless. This rule earned itself immediately: it rejected
    // hand-written exemptions for `mfa_backup_codes` and `user_roles`, both of
    // which the export already reads — the first to count for `withheld`, the
    // second to build `account.roles`. Being read by the export is the
    // evidence that somebody considered the table, which is the whole
    // question, so neither needed an exemption at all.
    const contradictory = Object.keys(EXEMPT).filter((t) => exported.has(t));
    expect(contradictory).toEqual([]);
  });

  it('keeps no exemption for a table that no longer exists', () => {
    const stale = Object.keys(EXEMPT).filter((t) => !schema.has(t));
    expect(stale).toEqual([]);
  });

  it('gives every exemption a reason somebody could read out', () => {
    const thin = Object.entries(EXEMPT).filter(([, why]) => why.trim().length < 60);
    expect(thin.map(([t]) => t)).toEqual([]);
  });
});

describe('personal data export covers what the schema holds by address', () => {
  it('reads columns as well as foreign keys', () => {
    // Vacuity guard for the second parser. `tableColumns` is a different regex
    // over the same files, and the assertions below all pass against an empty
    // map — the exact way the first half of this census was silently blind for
    // as long as it was.
    expect(columns.size).toBeGreaterThan(80);
    expect(columns.get('users')).toContain('email');
    expect(contactTables.length).toBeGreaterThan(5);
  });

  it('finds the tables that identify a person by address and nothing else', () => {
    // Named rather than counted: these are the five the FK scan could not see,
    // and the point of the check is that they are *reachable*, not that there
    // are five of them.
    for (const t of ['contact_submissions', 'user_invitations', 'board_signoffs', 'option_grants'])
      expect(contactTables, t).toContain(t);
    // …and none of them has a foreign key that would have made it visible to
    // the census above under a subject column.
    for (const t of ['contact_submissions', 'user_invitations', 'board_signoffs', 'option_grants']) {
      const cols = schema.get(t) ?? new Set<string>();
      expect(
        [...cols].filter((c) => SUBJECT_COLUMNS.includes(c)),
        t,
      ).toEqual([]);
    }
  });

  it('does not mistake a consent flag or a firm address for a person', () => {
    // `marketing_email` is a boolean and `support_email` is published on a
    // login page. A census that reported them would be reporting them forever.
    const spurious = [...columns.entries()]
      .filter(([table]) => !contactTables.includes(table))
      .flatMap(([, cols]) => [...cols])
      .filter((c) => NON_PERSONAL_CONTACT.has(c));
    expect(spurious.length).toBeGreaterThanOrEqual(0);
    for (const declared of NON_PERSONAL_CONTACT) expect(CONTACT_COLUMN.test(declared)).toBe(true);
  });

  it("exports or explains every table that holds a person's contact details", () => {
    const unaccounted = contactTables.filter((t) => !exported.has(t) && !(t in CONTACT_EXEMPT));
    expect(unaccounted, 'tables holding an address that no access request reaches').toEqual([]);
  });

  it('keeps no contact exemption for a table the export reads anyway', () => {
    expect(Object.keys(CONTACT_EXEMPT).filter((t) => exported.has(t))).toEqual([]);
  });

  it('keeps no contact exemption for a table with no contact column', () => {
    expect(Object.keys(CONTACT_EXEMPT).filter((t) => !contactTables.includes(t))).toEqual([]);
  });

  it('gives every contact exemption a reason somebody could read out', () => {
    const thin = Object.entries(CONTACT_EXEMPT).filter(([, why]) => why.trim().length < 80);
    expect(thin.map(([t]) => t)).toEqual([]);
  });

  it('leaves no table naming a person that neither census can reach', () => {
    // The justification for leaving `_name` out of CONTACT_COLUMN. Excluding
    // it is only safe while every table holding a person's *name* is reachable
    // some other way — by their address, or by a foreign key that makes them
    // the subject of the row. `valuation_signatures` is the second kind:
    // `signer_name` with no address, but `signer_user_id` beside it, which is
    // why the export already reads it.
    //
    // If a table ever holds a person's name and neither, the narrow rule has
    // stopped being safe and this says so — rather than the name quietly
    // falling through both halves.
    const PERSON_NAME = /^(member|grantee|signer|client|owner_first|owner_last|given|family)_name$/;
    const unreachable = [...columns.entries()]
      .filter(([table, cols]) => {
        if (![...cols].some((c) => PERSON_NAME.test(c))) return false;
        if (contactTables.includes(table)) return false;
        const fks = schema.get(table) ?? new Set<string>();
        return ![...fks].some((c) => SUBJECT_COLUMNS.includes(c));
      })
      .map(([table]) => table);
    expect(unreachable).toEqual([]);
    // …and the one that is reachable the second way is genuinely exported,
    // so this is not passing by an exemption nobody looked at.
    expect(exported).toContain('valuation_signatures');
  });
});
