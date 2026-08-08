import type pg from 'pg';
import { newUlid } from '@n409/shared';
import type { AutoEmailRow, CommChannel, CommunicationTemplateRow } from '../domain/communications.js';

// ── Communication templates (409.ai §15.5) ───────────────────────────────────

export async function listCommunicationTemplates(pool: pg.Pool): Promise<CommunicationTemplateRow[]> {
  const { rows } = await pool.query<CommunicationTemplateRow>(
    'SELECT * FROM communication_templates ORDER BY key',
  );
  return rows;
}

export async function findTemplateByKey(
  db: pg.Pool | pg.PoolClient,
  key: string,
): Promise<CommunicationTemplateRow | null> {
  const { rows } = await db.query<CommunicationTemplateRow>(
    'SELECT * FROM communication_templates WHERE key = $1',
    [key],
  );
  return rows[0] ?? null;
}

export async function findTemplateById(pool: pg.Pool, id: string): Promise<CommunicationTemplateRow | null> {
  const { rows } = await pool.query<CommunicationTemplateRow>(
    'SELECT * FROM communication_templates WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** Enabled+disabled override rows for a set of workflow template keys. */
export async function templateOverrides(
  db: pg.Pool | pg.PoolClient,
  keys: string[],
): Promise<Map<string, Pick<CommunicationTemplateRow, 'subject' | 'body' | 'enabled'>>> {
  if (keys.length === 0) return new Map();
  const { rows } = await db.query<CommunicationTemplateRow>(
    'SELECT key, subject, body, enabled FROM communication_templates WHERE key = ANY($1)',
    [keys],
  );
  return new Map(rows.map((r) => [r.key, { subject: r.subject, body: r.body, enabled: r.enabled }]));
}

export async function createCommunicationTemplate(
  pool: pg.Pool,
  input: {
    key: string;
    channel: CommChannel;
    description: string;
    subject: string;
    body: string;
    enabled: boolean;
  },
  updatedBy: string,
): Promise<CommunicationTemplateRow> {
  const { rows } = await pool.query<CommunicationTemplateRow>(
    `INSERT INTO communication_templates (id, key, channel, description, subject, body, enabled, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      newUlid(),
      input.key,
      input.channel,
      input.description,
      input.subject,
      input.body,
      input.enabled,
      updatedBy,
    ],
  );
  return rows[0]!;
}

export async function updateCommunicationTemplate(
  pool: pg.Pool,
  id: string,
  patch: Partial<Pick<CommunicationTemplateRow, 'description' | 'subject' | 'body' | 'enabled'>>,
  updatedBy: string,
): Promise<CommunicationTemplateRow | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  params.push(updatedBy);
  sets.push(`updated_by = $${params.length}`);
  params.push(id);
  const { rows } = await pool.query<CommunicationTemplateRow>(
    `UPDATE communication_templates SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

/** Refuses when a campaign still references the template (FK would fail anyway). */
export async function deleteCommunicationTemplate(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM communication_templates
     WHERE id = $1
       AND NOT EXISTS (
         SELECT 1 FROM auto_emails a
         JOIN communication_templates t ON t.key = a.template_key
         WHERE t.id = $1
       )`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

// ── Auto email campaigns (409.ai §15.6) ──────────────────────────────────────

export async function listAutoEmails(db: pg.Pool | pg.PoolClient): Promise<AutoEmailRow[]> {
  const { rows } = await db.query<AutoEmailRow>('SELECT * FROM auto_emails ORDER BY name');
  return rows;
}

export async function findAutoEmailById(pool: pg.Pool, id: string): Promise<AutoEmailRow | null> {
  const { rows } = await pool.query<AutoEmailRow>('SELECT * FROM auto_emails WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function createAutoEmail(
  pool: pg.Pool,
  input: Pick<
    AutoEmailRow,
    | 'name'
    | 'channel'
    | 'trigger_state'
    | 'condition'
    | 'delay_hours'
    | 'repeat_hours'
    | 'max_sends'
    | 'template_key'
    | 'enabled'
  >,
): Promise<AutoEmailRow> {
  const { rows } = await pool.query<AutoEmailRow>(
    `INSERT INTO auto_emails
       (id, name, channel, trigger_state, condition, delay_hours, repeat_hours, max_sends, template_key, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      newUlid(),
      input.name,
      input.channel,
      input.trigger_state,
      input.condition,
      input.delay_hours,
      input.repeat_hours,
      input.max_sends,
      input.template_key,
      input.enabled,
    ],
  );
  return rows[0]!;
}

export async function updateAutoEmail(
  pool: pg.Pool,
  id: string,
  patch: Partial<
    Pick<
      AutoEmailRow,
      | 'channel'
      | 'trigger_state'
      | 'condition'
      | 'delay_hours'
      | 'repeat_hours'
      | 'max_sends'
      | 'template_key'
      | 'enabled'
    >
  >,
): Promise<AutoEmailRow | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  params.push(id);
  const { rows } = await pool.query<AutoEmailRow>(
    `UPDATE auto_emails SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

export async function deleteAutoEmail(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM auto_emails WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

// ── Drip scan support ─────────────────────────────────────────────────────────

export interface DueCandidate {
  valuation_id: string;
  company_name: string;
  kind: string;
  number: string;
  user_id: string;
  to_email: string;
  to_phone: string | null;
  state_entered_at: Date;
  prior_sends_at: Date[];
}

/**
 * Valuations sitting in the campaign's trigger state, with the campaign's
 * condition applied, plus the data isCampaignDue() and rendering need. The
 * due-window check itself stays in domain code (testable without a DB).
 */
export async function dueCandidates(
  db: pg.Pool | pg.PoolClient,
  campaign: AutoEmailRow,
): Promise<DueCandidate[]> {
  const conditionSql: Record<string, string> = {
    always: 'true',
    unpaid: "v.paid_status = 'unpaid'",
    // 'paid_by_partner' is paid as far as the client is concerned — a campaign
    // that talks about the work rather than the invoice must not skip a
    // partner-billed engagement.
    paid: "v.paid_status <> 'unpaid'",
    no_documents:
      'NOT EXISTS (SELECT 1 FROM documents d WHERE d.valuation_id = v.id AND d.deleted_at IS NULL)',
    waiting_on_client: 'v.waiting_on_client',
    // No questionnaire row at all counts as incomplete: a client who never
    // opened the form is the one most in need of the nudge.
    intake_incomplete: `NOT EXISTS (
      SELECT 1 FROM intake_questionnaires q
       WHERE q.valuation_id = v.id AND q.submitted_at IS NOT NULL)`,
    no_captable: `NOT EXISTS (
      SELECT 1 FROM documents d
       WHERE d.valuation_id = v.id AND d.deleted_at IS NULL AND d.kind = 'cap_table')`,
    no_financials: `NOT EXISTS (
      SELECT 1 FROM documents d
       WHERE d.valuation_id = v.id AND d.deleted_at IS NULL
         AND d.kind IN ('income_statement', 'balance_sheet', 'cash_flow', 'projections'))`,
    unassigned_reviewer: 'v.assigned_reviewer_id IS NULL',
    unsigned: `NOT EXISTS (
      SELECT 1 FROM valuation_signatures s WHERE s.valuation_id = v.id)`,
  };
  const { rows } = await db.query<DueCandidate>(
    `SELECT v.id AS valuation_id, v.company_name, v.kind, v.number::text AS number,
            v.user_id, u.email AS to_email, u.phone AS to_phone,
            COALESCE(
              (SELECT max(e.occurred_at) FROM valuation_events e
               WHERE e.valuation_id = v.id AND e.type = 'state_changed'),
              v.created_at
            ) AS state_entered_at,
            COALESCE(
              (SELECT array_agg(s.sent_at ORDER BY s.sent_at DESC) FROM auto_email_sends s
               WHERE s.auto_email_id = $1 AND s.valuation_id = v.id),
              '{}'
            ) AS prior_sends_at
     FROM valuations v
     JOIN users u ON u.id = v.user_id
     WHERE v.state = $2 AND ${conditionSql[campaign.condition] ?? 'false'}`,
    [campaign.id, campaign.trigger_state],
  );
  return rows;
}

export async function recordAutoEmailSend(
  db: pg.Pool | pg.PoolClient,
  input: { autoEmailId: string; valuationId: string; outboxId: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO auto_email_sends (id, auto_email_id, valuation_id, outbox_id)
     VALUES ($1, $2, $3, $4)`,
    [newUlid(), input.autoEmailId, input.valuationId, input.outboxId],
  );
}
