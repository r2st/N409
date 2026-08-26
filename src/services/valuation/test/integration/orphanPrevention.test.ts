import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hardDeletedTables } from '../support/hardDeletes.js';
import { sourceFiles } from '../support/sourceFiles.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * Why this schema cannot accumulate orphans, stated so it can stop being true
 * loudly rather than quietly.
 *
 * An orphan is a row whose parent is gone. There are only two ways to get one:
 * a parent-child relationship with no foreign key behind it, or a foreign key
 * that was dropped. The catalog answers the second. This census answers the
 * first, by taking every column shaped like a reference — `%_id` — and
 * requiring each one to be a foreign key or to have a reason it is not.
 *
 * There are exactly two reasons, and they are different in kind.
 *
 * `EXTERNAL` columns hold an identifier belonging to somebody else's system:
 * a Stripe charge, a SCIM external id, a SAML entity, the previous platform's
 * workflow id. There is no local row for a constraint to point at, and a value
 * that stops resolving is that provider's business, not an orphan.
 *
 * `POLYMORPHIC` columns do point at rows in this database, but at rows in more
 * than one table depending on a sibling column, which is precisely what a
 * foreign key cannot express. These are the ones that *could* dangle — so each
 * is listed with the tables it can point at, and the test asserts that none of
 * those tables is one this service ever deletes from. That is the whole
 * argument: a reference nothing can delete out from under cannot be orphaned,
 * and if somebody adds a `DELETE FROM users` tomorrow, this fails and names the
 * columns that just became capable of dangling.
 *
 * The lists are exhaustive by construction — a new `%_id` column that is
 * neither a foreign key nor listed here fails the census, so the choice has to
 * be made deliberately rather than by not noticing.
 */
const EXTERNAL: ReadonlyMap<string, string> = new Map([
  ['accounting_connections.external_org_id', "the accounting provider's organisation id"],
  ['cap_table_connections.external_company_id', "the cap-table provider's company id"],
  ['email_delivery_events.provider_event_id', "the ESP's own event id, for dedupe"],
  ['hris_connections.external_company_id', "the HRIS provider's company id"],
  ['invoices.stripe_invoice_id', 'Stripe'],
  ['network_items.request_id', "the requesting system's correlation id"],
  ['option_grants.external_id', "the equity platform's grant id"],
  ['payments.charge_id', 'Stripe'],
  ['payments.payment_intent_id', 'Stripe'],
  ['payments.session_id', 'Stripe Checkout'],
  ['saml_assertions_seen.assertion_id', "the IdP's assertion id, held to refuse a replay"],
  ['saml_config.idp_entity_id', 'the identity provider'],
  ['saml_config.sp_entity_id', 'this service, as the IdP names it'],
  ['stripe_webhook_events.event_id', 'Stripe'],
  ['stripe_webhook_events.object_id', 'Stripe'],
  ['subscriptions.stripe_customer_id', 'Stripe'],
  ['subscriptions.stripe_subscription_id', 'Stripe'],
  ['users.scim_external_id', "the SCIM provider's user id"],
  ['valuations.external_id', "the partner's own id for the engagement (0164)"],
  ['valuations.workflow_id', 'the id the engagement carries in the previous platform'],
]);

/**
 * Polymorphic columns whose value must still resolve.
 *
 * Each is listed with every table it can name, and the test asserts that none
 * of those tables is one this service deletes from. That is what stands in for
 * the foreign key these columns cannot have: a reference nothing can delete out
 * from under cannot be orphaned. Add a `DELETE FROM users` and this fails,
 * naming the columns that just became capable of dangling.
 */
const LIVE_REFERENCES: ReadonlyMap<string, readonly string[]> = new Map([
  // `scope` is 'global' | 'valuation' | 'user'; 'global' carries no reference.
  // A hold that stopped resolving would stop blocking a purge, so this one is
  // load-bearing rather than cosmetic.
  ['legal_holds.reference_id', ['valuations', 'users']],
  // `data_type` names the class of record the decision was about.
  ['retention_actions.reference_id', ['valuations', 'users']],
  // `actor_type` is 'user' | 'system' | 'partner'; system events carry no id.
  ['admin_events.actor_id', ['users']],
  ['valuation_events.actor_id', ['users', 'partners']],
]);

/**
 * The one reference that is *supposed* to outlive what it names.
 *
 * `admin_events.subject_id` is the audit ledger's account of what was acted on,
 * and seventeen different `subject_type`s reach it — a dozen of them
 * configuration objects that are genuinely hard-deleted: auto-email campaigns,
 * help articles, communication templates, blog posts. Constraining it would
 * mean either refusing to delete a template because an audit row mentions it,
 * or deleting the audit row with it. Both are worse than a dangling id, and the
 * schema has already made this choice explicitly once — migration 0168 is named
 * `ledger_survives_its_owner`.
 *
 * So dangling is the design, and what has to hold instead is that nothing
 * *depends* on it resolving. Two things make that true, and both are asserted
 * below rather than assumed:
 *
 *   - the row carries `subject_label`, so a reader renders a deleted subject's
 *     name from the ledger itself and never needs the row it names;
 *   - the single query that does join on `subject_id` restricts to
 *     `subject_type = 'valuation'` first, and valuations are never deleted. An
 *     ungated inner join here would silently drop audit entries from the
 *     activity feed — the failure would look like a gap in the log, not an
 *     error ([[n409-swallowed-load-errors]]).
 */
const AUDIT_REFERENCE = 'admin_events.subject_id';

/**
 * Only the subject types a join is allowed to assume resolve — the ones whose
 * table nothing deletes. Deliberately not the full seventeen: this is the
 * whitelist for `JOIN ... ON x.id = a.subject_id`, not a description of the
 * vocabulary.
 */
const SUBJECT_TABLE_FOR_JOIN: ReadonlyMap<string, string> = new Map([
  ['valuation', 'valuations'],
  ['user', 'users'],
  ['partner', 'partners'],
]);

/** Every `%_id` column that no foreign key constrains. */
const UNCONSTRAINED_SQL = `
WITH cols AS (
  SELECT c.relname AS tbl, a.attname AS col
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
     AND a.attnum > 0 AND NOT a.attisdropped AND a.attname LIKE '%\\_id'),
fkcols AS (
  SELECT src.relname AS tbl, a.attname AS col
    FROM pg_constraint k
    JOIN pg_class src ON src.oid = k.conrelid
    JOIN unnest(k.conkey) u(att) ON true
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.att
   WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace)
SELECT tbl, col FROM cols
 WHERE NOT EXISTS (SELECT 1 FROM fkcols f WHERE f.tbl = cols.tbl AND f.col = cols.col)
 ORDER BY tbl, col`;

describe.skipIf(!dbUp)('nothing in this schema can be orphaned (R166)', () => {
  let db: TestDb;
  let unconstrained: string[];
  let deleted: Map<string, Set<string>>;

  beforeAll(async () => {
    db = await setupTestDb();
    const { rows } = await db.pool.query<{ tbl: string; col: string }>(UNCONSTRAINED_SQL);
    unconstrained = rows.map((r) => `${r.tbl}.${r.col}`);
    deleted = hardDeletedTables(SRC);
  });
  afterAll(async () => db?.teardown());

  it('has reference columns to account for at all', () => {
    // Guard against the census passing because the LIKE stopped matching.
    expect(unconstrained.length).toBeGreaterThan(15);
    expect(unconstrained).toContain('payments.charge_id');
  });

  it('accounts for every unconstrained reference column', () => {
    const accounted = (c: string): boolean =>
      EXTERNAL.has(c) || LIVE_REFERENCES.has(c) || c === AUDIT_REFERENCE;
    expect(unconstrained.filter((c) => !accounted(c))).toEqual([]);
  });

  it('lists nothing that has since gained a foreign key', () => {
    // An entry for a column that is now constrained (or gone) is a stale
    // licence, and reads to the next person as a live hole that it is not.
    const live = new Set(unconstrained);
    const listed = [...EXTERNAL.keys(), ...LIVE_REFERENCES.keys(), AUDIT_REFERENCE];
    expect(listed.filter((c) => !live.has(c))).toEqual([]);
  });

  it('never lets a live reference point at a table something deletes', () => {
    const exposed: string[] = [];
    for (const [column, targets] of LIVE_REFERENCES) {
      for (const table of targets) {
        if (deleted.has(table)) {
          exposed.push(`${column} -> ${table} (deleted in ${[...deleted.get(table)!].sort().join(', ')})`);
        }
      }
    }
    expect(exposed).toEqual([]);
  });

  it('names only real tables in the live-reference targets', async () => {
    // A typo above would exempt a column by pointing at nothing, and the delete
    // check would pass for the same reason.
    const { rows } = await db.pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
    );
    const real = new Set(rows.map((r) => r.relname));
    const bogus = [...new Set([...LIVE_REFERENCES.values()].flat())].filter((t) => !real.has(t));
    expect(bogus).toEqual([]);
  });

  it('keeps the audit ledger readable without the subject it names', async () => {
    // The label is what makes a dangling `subject_id` harmless. If it were ever
    // dropped, or made nullable-in-practice by a writer that stops setting it,
    // a deleted template would render as a bare id.
    const { rows } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'admin_events' AND column_name = 'subject_label'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('gates every join on subject_id by a subject type that is never deleted', () => {
    // A source scan, because the risk is a *new* query: the ledger is allowed to
    // name rows that are gone, so any inner join onto it has to say which
    // subject type it means before it can assume the row is there.
    const ungated: string[] = [];
    let joins = 0;
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      // Anchored on the ON predicate rather than on `JOIN ... subject_id`,
      // which spans whatever sits between two unrelated statements.
      for (const m of text.matchAll(/ON\s+\w+\.\w+\s*=\s*\w+\.subject_id/g)) {
        const window = text.slice(m.index!, m.index! + m[0].length + 300);
        const subjectType = window.match(/subject_type\s*=\s*'([a-z_]+)'/);
        joins++;
        const table = subjectType ? SUBJECT_TABLE_FOR_JOIN.get(subjectType[1]!) : undefined;
        if (!table || deleted.has(table)) {
          ungated.push(`${file.slice(SRC.length)}: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`);
        }
      }
    }
    expect(ungated).toEqual([]);
    // The join this was written about is still there to be judged. Without
    // this, a rename of `subject_id` turns the sweep into one that passes by
    // having nothing to look at ([[n409-vacuous-checks]]).
    expect(joins).toBe(1);
  });

  /**
   * And the constrained majority actually holds: every foreign key is enforced
   * rather than sitting there NOT VALID, which Postgres allows and which would
   * let pre-existing orphans survive a constraint that looks present in `\d`.
   */
  it('has no foreign key that was added without validating existing rows', async () => {
    const { rows } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND NOT convalidated`,
    );
    expect(rows.map((r) => r.conname)).toEqual([]);
  });
});
