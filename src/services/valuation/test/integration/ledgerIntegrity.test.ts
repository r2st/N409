import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The rows that have to outlive whoever they belong to.
 *
 * Migration 0168 turned three cascades into refusals. This asks the database
 * whether they are still refusals, and — the half that matters more — whether
 * the roster of tables that deserve one is still the whole roster.
 *
 * The distinction the roster draws is between money the business *billed or
 * received* and money that is an input to a valuation. `funding_rounds`,
 * `valuation_params` and `valuations` all carry `_cents` columns and all of
 * them are inputs: they describe the company being valued, they mean nothing
 * without the valuation they hang off, and cascading away with it is correct.
 * `invoices`, `subscriptions` and `payments` are records of a transaction with
 * a customer. Nobody's accounts are restated because a user row was removed.
 */
describe.skipIf(!dbUp)('ledger integrity', () => {
  let db: TestDb;

  /** Tables whose rows must survive the deletion of anything they point at. */
  const LEDGER = ['invoices', 'subscriptions', 'payments'] as const;

  /**
   * Every table holding a money column, and why each one is or is not a ledger.
   * A new `_cents` column on a new table fails the completeness check below,
   * which is how a future billing table is forced through this decision rather
   * than inheriting whatever cascade its migration happened to type.
   *
   * `subscriptions` is a ledger and is deliberately absent: it carries no
   * amount of its own, only a `plan_tier` pointing at the price list. That it
   * cannot be reached from a money column is exactly why the roster below is
   * checked and the ledger list is not derived from it.
   */
  const MONEY_TABLES: Record<string, string> = {
    invoices: 'ledger — what the customer was billed',
    payments: 'ledger — what the customer paid',
    plan_limits: 'price list, referenced by subscriptions; not per-customer',
    funding_rounds: 'valuation input — the round being valued',
    valuation_params: 'valuation input — revenue fed to the income approach',
    valuation_transactions: 'valuation input — a secondary sale used as evidence',
    valuations: 'valuation input — the engagement fee and the raise',
  };

  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => db?.teardown());

  /**
   * A user, and a valuation only when the case needs one. `valuations.user_id`
   * already refuses a user delete on its own, so seeding one unconditionally
   * would let these pass with the cascades put back.
   */
  const seedUserRow = async (): Promise<string> => {
    const userId = newUlid();
    await db.pool.query(`INSERT INTO users (id, email, password_digest) VALUES ($1, $2, 'x')`, [
      userId,
      `${userId}@ledger.test`,
    ]);
    return userId;
  };

  const seedValuation = async (userId: string): Promise<string> => {
    const valuationId = newUlid();
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id) VALUES ($1, '409a', 'Ledger Co', $2)`,
      [valuationId, userId],
    );
    return valuationId;
  };

  it('refuses to delete a user who has been invoiced, and keeps the invoice', async () => {
    const userId = await seedUserRow();
    const invoiceId = newUlid();
    await db.pool.query(
      `INSERT INTO invoices (id, number, user_id, amount_cents) VALUES ($1, $2, $3, 200000)`,
      [invoiceId, `INV-${invoiceId}`, userId],
    );

    await expect(db.pool.query('DELETE FROM users WHERE id = $1', [userId])).rejects.toThrow(
      /invoices_user_id_fkey/,
    );
    const { rows } = await db.pool.query('SELECT amount_cents FROM invoices WHERE id = $1', [invoiceId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(200000);
  });

  it('refuses to delete a user who has a subscription', async () => {
    const userId = await seedUserRow();
    await db.pool.query(
      `INSERT INTO subscriptions (id, user_id, plan_tier) VALUES ($1, $2, 'annual_retainer')`,
      [newUlid(), userId],
    );
    await expect(db.pool.query('DELETE FROM users WHERE id = $1', [userId])).rejects.toThrow(
      /subscriptions_user_id_fkey/,
    );
  });

  it('refuses to delete a valuation that has been paid for', async () => {
    const valuationId = await seedValuation(await seedUserRow());
    const paymentId = newUlid();
    await db.pool.query(
      `INSERT INTO payments (id, valuation_id, session_id, amount_cents) VALUES ($1, $2, $3, 200000)`,
      [paymentId, valuationId, `cs_${paymentId}`],
    );
    await expect(db.pool.query('DELETE FROM valuations WHERE id = $1', [valuationId])).rejects.toThrow(
      /payments_valuation_id_fkey/,
    );
    const { rowCount } = await db.pool.query('SELECT 1 FROM payments WHERE id = $1', [paymentId]);
    expect(rowCount).toBe(1);
  });

  /**
   * The refusal is specific. A user who owes nothing and is owed nothing still
   * goes, and takes their preferences with them — otherwise 0168 would have
   * quietly made every user permanent, which is a different bug wearing the
   * same constraint.
   */
  it('still deletes a user who has only cascade-able rows', async () => {
    const userId = await seedUserRow();
    await db.pool.query(`INSERT INTO saved_views (id, owner_id, name) VALUES ($1, $2, 'Mine')`, [
      newUlid(),
      userId,
    ]);

    await db.pool.query('DELETE FROM users WHERE id = $1', [userId]);
    const { rowCount } = await db.pool.query('SELECT 1 FROM saved_views WHERE owner_id = $1', [userId]);
    expect(rowCount).toBe(0);
  });

  it('leaves no cascade pointing at a ledger table', async () => {
    const { rows } = await db.pool.query<{ tbl: string; conname: string; action: string }>(
      `SELECT src.relname AS tbl, c.conname, c.confdeltype AS action
         FROM pg_constraint c
         JOIN pg_class src ON src.oid = c.conrelid
        WHERE c.contype = 'f' AND src.relname = ANY($1) AND c.confdeltype = 'c'`,
      [[...LEDGER]],
    );
    expect(rows).toEqual([]);
  });

  /**
   * And the roster itself, against the schema. A table that starts holding
   * money has to be classified here — as a ledger, which means adding it to
   * LEDGER and giving its FKs a delete action that refuses, or as a valuation
   * input, which means saying so.
   */
  it('classifies every table that holds money', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT DISTINCT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.column_name LIKE '%\\_cents'
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(Object.keys(MONEY_TABLES).sort());
    // Every money table classified as a ledger is on the list the cascade
    // check above reads, so the prose and the constraint cannot drift apart.
    for (const [table, why] of Object.entries(MONEY_TABLES)) {
      expect(LEDGER.includes(table as (typeof LEDGER)[number])).toBe(why.startsWith('ledger —'));
    }
  });
});
