import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';
import { AUTO_EMAIL_CONDITIONS, type AutoEmailRow } from '../../src/domain/communications.js';
import { dueCandidates, listAutoEmails } from '../../src/repos/communications.js';

const dbUp = await isDbAvailable();

/**
 * The full auto email/SMS sequence set (migration 0104).
 *
 * The value of the seed is not that the rows exist — it is that every campaign
 * points at a template that renders and a condition the scan can actually
 * evaluate. A campaign whose condition SQL is missing silently matches nothing
 * (`?? 'false'`), so it would ship looking configured and never send.
 */
describe.skipIf(!dbUp)('notification sequences', () => {
  let db: TestDb;
  let campaigns: AutoEmailRow[];

  beforeAll(async () => {
    db = await setupTestDb();
    campaigns = await listAutoEmails(db.pool);
  }, 60_000);
  afterAll(async () => db?.teardown());

  it('seeds the full set of 27 sequences', async () => {
    expect(campaigns.length).toBe(27);
  });

  it('covers every client-visible lifecycle state', () => {
    const states = new Set(campaigns.map((c) => c.trigger_state));
    for (const state of [
      'pending',
      'started',
      'onboarding_completed',
      'user_finished',
      'completed',
      'review',
      'drafted',
      'draft_changes',
      'draft_accepted',
      'published',
      'timeout',
      'cancelled',
      'ignored',
    ]) {
      expect(states, `no campaign fires on ${state}`).toContain(state);
    }
  });

  it('points every campaign at an enabled template of the same channel', async () => {
    const { rows } = await db.pool.query<{ key: string; channel: string; enabled: boolean; body: string }>(
      'SELECT key, channel, enabled, body FROM communication_templates',
    );
    const templates = new Map(rows.map((r) => [r.key, r]));
    for (const c of campaigns) {
      const t = templates.get(c.template_key);
      expect(t, `campaign ${c.name} references missing template ${c.template_key}`).toBeTruthy();
      // A drip campaign has no code fallback — a disabled template means the
      // scan logs a warning and sends nothing, forever.
      expect(t!.enabled, `template ${c.template_key} is disabled`).toBe(true);
      expect(t!.channel, `channel mismatch on ${c.name}`).toBe(c.channel);
      expect(t!.body.length).toBeGreaterThan(0);
    }
  });

  it('leaves SMS opt-in — no deployment starts texting because a migration ran', () => {
    for (const c of campaigns.filter((x) => x.channel === 'sms')) {
      expect(c.enabled, `${c.name} ships enabled`).toBe(false);
    }
  });

  it('never repeats a message about an already-delivered report', () => {
    for (const c of campaigns.filter((x) => x.trigger_state === 'published')) {
      expect(c.repeat_hours, `${c.name} repeats`).toBeNull();
      expect(c.max_sends).toBe(1);
    }
  });

  it('evaluates every seeded condition against the schema', async () => {
    // The scan falls back to `false` for a condition it has no SQL for, so a
    // typo or a missing branch produces a campaign that matches nothing and
    // reports no error. Running each one proves the SQL parses and binds.
    for (const condition of AUTO_EMAIL_CONDITIONS) {
      const probe = { ...campaigns[0]!, condition, trigger_state: 'started' } as AutoEmailRow;
      await expect(dueCandidates(db.pool, probe), `condition ${condition}`).resolves.toBeInstanceOf(Array);
    }
  });

  it('selects a blocked valuation for each blocking condition, and drops it once unblocked', async () => {
    const userId = newUlid();
    const valuationId = newUlid();
    await db.pool.query(`INSERT INTO users (id, email, password_digest) VALUES ($1, $2, 'x')`, [
      userId,
      `seq-${userId}@example.com`,
    ]);
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, state)
       VALUES ($1, '409a', 'Blocked Co', $2, 'started')`,
      [valuationId, userId],
    );

    const matches = async (condition: string): Promise<boolean> => {
      const probe = { ...campaigns[0]!, condition, trigger_state: 'started' } as AutoEmailRow;
      const rows = await dueCandidates(db.pool, probe);
      return rows.some((r) => r.valuation_id === valuationId);
    };

    // Nothing uploaded, nothing submitted, nothing paid.
    expect(await matches('intake_incomplete')).toBe(true);
    expect(await matches('no_captable')).toBe(true);
    expect(await matches('no_financials')).toBe(true);
    expect(await matches('unpaid')).toBe(true);
    expect(await matches('paid')).toBe(false);

    // A cap table clears no_captable but not no_financials — this is exactly
    // the distinction no_documents could not make.
    await db.pool.query(
      `INSERT INTO documents (id, valuation_id, kind, filename, content_type, size_bytes, sha256, storage_path)
       VALUES ($1, $2, 'cap_table', 'cap.csv', 'text/csv', 10, 'abc', 'p/cap.csv')`,
      [newUlid(), valuationId],
    );
    expect(await matches('no_documents')).toBe(false);
    expect(await matches('no_captable')).toBe(false);
    expect(await matches('no_financials')).toBe(true);

    await db.pool.query(
      `INSERT INTO documents (id, valuation_id, kind, filename, content_type, size_bytes, sha256, storage_path)
       VALUES ($1, $2, 'income_statement', 'is.csv', 'text/csv', 10, 'def', 'p/is.csv')`,
      [newUlid(), valuationId],
    );
    expect(await matches('no_financials')).toBe(false);

    // A questionnaire that exists but was never submitted is still incomplete.
    await db.pool.query(`INSERT INTO intake_questionnaires (id, valuation_id) VALUES ($1, $2)`, [
      newUlid(),
      valuationId,
    ]);
    expect(await matches('intake_incomplete')).toBe(true);
    await db.pool.query('UPDATE intake_questionnaires SET submitted_at = now() WHERE valuation_id = $1', [
      valuationId,
    ]);
    expect(await matches('intake_incomplete')).toBe(false);

    // Partner-billed reads as paid: a campaign about the work must not skip it.
    await db.pool.query("UPDATE valuations SET paid_status = 'paid_by_partner' WHERE id = $1", [valuationId]);
    expect(await matches('unpaid')).toBe(false);
    expect(await matches('paid')).toBe(true);

    expect(await matches('unassigned_reviewer')).toBe(true);
    await db.pool.query('UPDATE valuations SET assigned_reviewer_id = $2 WHERE id = $1', [
      valuationId,
      userId,
    ]);
    expect(await matches('unassigned_reviewer')).toBe(false);

    expect(await matches('unsigned')).toBe(true);
    await db.pool.query(
      `INSERT INTO valuation_signatures (id, valuation_id, role, signer_user_id, signer_name, signature_text)
       VALUES ($1, $2, 'main', $3, 'A Nalyst', 'A Nalyst')`,
      [newUlid(), valuationId, userId],
    );
    expect(await matches('unsigned')).toBe(false);
  });
});
