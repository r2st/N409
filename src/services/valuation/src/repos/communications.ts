import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { publicPartnerNameSql } from './branding.js';
import {
  TEMPLATE_CATEGORIES,
  type AutoEmailRow,
  type CommChannel,
  type CommunicationTemplateRow,
  type TemplateCategory,
} from '../domain/communications.js';

// ── Communication templates (409.ai §15.5) ───────────────────────────────────

/**
 * Ordered by category and then key. The category order is the lifecycle order
 * from TEMPLATE_CATEGORIES rather than alphabetical, so the list reads in the
 * order an engagement passes through it — `array_position` over the constant
 * keeps that ordering in one place instead of duplicating it as a CASE here.
 */
export async function listCommunicationTemplates(
  pool: pg.Pool,
  filter: { category?: TemplateCategory; channel?: CommChannel } = {},
): Promise<CommunicationTemplateRow[]> {
  const { rows } = await pool.query<CommunicationTemplateRow>(
    `SELECT * FROM communication_templates
     WHERE ($1::text IS NULL OR category = $1)
       AND ($2::text IS NULL OR channel::text = $2)
     ORDER BY array_position($3::text[], category), key`,
    [filter.category ?? null, filter.channel ?? null, [...TEMPLATE_CATEGORIES]],
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

/**
 * Whole template rows for a set of keys, keyed by key.
 *
 * Separate from `templateOverrides` despite the near-identical query, because
 * the two answer different questions about a missing row: there it means "no
 * override recorded, use the built-in workflow template", here it means "this
 * campaign names a template that does not exist and must not send".
 */
export async function findTemplatesByKeys(
  db: pg.Pool | pg.PoolClient,
  keys: readonly string[],
): Promise<Map<string, CommunicationTemplateRow>> {
  if (keys.length === 0) return new Map();
  const { rows } = await db.query<CommunicationTemplateRow>(
    'SELECT * FROM communication_templates WHERE key = ANY($1)',
    [[...new Set(keys)]],
  );
  return new Map(rows.map((r) => [r.key, r]));
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
    category: TemplateCategory;
    description: string;
    subject: string;
    body: string;
    enabled: boolean;
  },
  updatedBy: string,
): Promise<CommunicationTemplateRow> {
  const { rows } = await pool.query<CommunicationTemplateRow>(
    `INSERT INTO communication_templates
       (id, key, channel, category, description, subject, body, enabled, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      newUlid(),
      input.key,
      input.channel,
      input.category,
      input.description,
      input.subject,
      input.body,
      input.enabled,
      updatedBy,
    ],
  );
  return rows[0]!;
}

/**
 * Columns a template patch may name. The key is interpolated into SQL rather
 * than bound — a column name cannot be a parameter — so what is allowed to
 * reach that position has to be decided here and not by the caller.
 *
 * Today's caller passes `TemplatePatch.safeParse(...).data`, and a plain Zod
 * object strips unknown keys, so nothing else can arrive. That is a property of
 * one schema at one call site, not of this function: `.passthrough()`, a second
 * caller, or a hand-built patch object each turn `Object.entries(patch)` into
 * attacker-chosen SQL. The type annotation says the same thing and is erased at
 * runtime. Every sibling repo that builds an UPDATE this way — narrativePrompts,
 * branding, params, adminUsers, grants, clientIntake — names its columns in the
 * repo; these two were the outliers.
 */
const TEMPLATE_PATCH_COLUMNS: ReadonlySet<string> = new Set([
  'category',
  'description',
  'subject',
  'body',
  'enabled',
]);

export async function updateCommunicationTemplate(
  pool: pg.Pool,
  id: string,
  patch: Partial<Pick<CommunicationTemplateRow, 'category' | 'description' | 'subject' | 'body' | 'enabled'>>,
  updatedBy: string,
): Promise<CommunicationTemplateRow | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !TEMPLATE_PATCH_COLUMNS.has(key)) continue;
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
  > &
    // Optional, and defaulted to transactional rather than required: the safe
    // direction is the one an operator must consciously change, and a caller
    // that has not thought about it has not decided a campaign is marketing.
    Partial<Pick<AutoEmailRow, 'promotional'>>,
): Promise<AutoEmailRow> {
  const { rows } = await pool.query<AutoEmailRow>(
    `INSERT INTO auto_emails
       (id, name, channel, trigger_state, condition, delay_hours, repeat_hours, max_sends,
        template_key, enabled, promotional)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      input.promotional ?? false,
    ],
  );
  return rows[0]!;
}

/** Columns a campaign patch may name — see TEMPLATE_PATCH_COLUMNS for why. */
const AUTO_EMAIL_PATCH_COLUMNS: ReadonlySet<string> = new Set([
  'channel',
  'trigger_state',
  'condition',
  'delay_hours',
  'repeat_hours',
  'max_sends',
  'template_key',
  'enabled',
  'promotional',
]);

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
      | 'promotional'
    >
  >,
): Promise<AutoEmailRow | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !AUTO_EMAIL_PATCH_COLUMNS.has(key)) continue;
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
  /**
   * Whether this recipient still consents to marketing email (migration 0118).
   * Read here rather than in a second query per candidate: the scan already
   * touches one row per valuation, and a promotional campaign that had to
   * round-trip for consent would do so once per hit.
   */
  marketing_email: boolean;
  /**
   * The rest of what `valuationTemplateVars` and `alwaysTemplateVars` answer.
   *
   * The scan rendered its templates from `company_name`, `kind` and `number`
   * alone, so `{{valuation_date}}`, `{{due_date}}`, `{{state_label}}` and
   * `{{partner_name}}` — every one of them declared in the catalog and filled
   * in the operator's preview — arrived at the client as an empty gap in a
   * sentence. They are all one join or one column away from a query this path
   * was already running once per page.
   *
   * `valuation_date` is the measurement date out of `valuation_params`
   * (0041) rather than a column on the valuation, which is where the preview
   * route reads it from too.
   */
  recipient_name: string | null;
  valuation_date: string | null;
  due_date: Date | null;
  state: string;
  partner_name: string | null;
}

/**
 * Valuations sitting in the campaign's trigger state, with the campaign's
 * condition applied, plus the data isCampaignDue() and rendering need. The
 * due-window check itself stays in domain code (testable without a DB).
 *
 * Both soft deletes are applied here, and this is the only place they can be:
 * nothing between this query and `transport.send` re-checks either, so a row
 * returned here is a message that leaves the building.
 *
 *   * `v.archived_at IS NULL` — archiving is the soft delete for valuations,
 *     and `buildValuationWhere` filters it out of the list, the counts and the
 *     export. A campaign builds its own WHERE, so it inherited none of it and
 *     kept nudging clients about engagements the firm had retired: "we still
 *     need your cap table" for work nobody is doing, on a cadence, for as many
 *     sends as `max_sends` allows.
 *   * `u.deleted_at IS NULL` — the matching rule for the recipient, which every
 *     other reader of `users` already applies (`listUsers`, the firm roster,
 *     the reviewer picker, password reset, email verification). Without it a
 *     deactivated account kept receiving automated mail, which is the one thing
 *     deactivating it was supposed to stop.
 *
 * Neither is a marketing-consent question, so neither belongs in
 * `isSuppressed`: consent is the recipient declining, this is the platform
 * having no business writing at all. That is also why the two are refused here
 * rather than counted as `suppressed` — a suppressed send is a decision about a
 * real candidate, and these are not candidates.
 */
export async function dueCandidates(
  db: pg.Pool | pg.PoolClient,
  campaign: AutoEmailRow,
  opts: { limit?: number; after?: string | null } = {},
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
  const size = Math.min(Math.max(opts.limit ?? AUTO_EMAIL_PAGE_LIMIT, 1), AUTO_EMAIL_PAGE_LIMIT);
  const params: unknown[] = [campaign.id, campaign.trigger_state, size];
  const cursorSql = opts.after ? `AND v.id > $${params.push(opts.after)}` : '';
  const { rows } = await db.query<DueCandidate>(
    `SELECT v.id AS valuation_id, v.company_name, v.kind, v.number::text AS number,
            v.user_id, u.email AS to_email, u.phone AS to_phone,
            u.first_name AS recipient_name, v.due_date, v.state,
            ${publicPartnerNameSql('p')} AS partner_name,
            (SELECT vp.engine_inputs->>'valuation_date' FROM valuation_params vp
              WHERE vp.valuation_id = v.id) AS valuation_date,
            COALESCE(
              (SELECT max(e.occurred_at) FROM valuation_events e
               WHERE e.valuation_id = v.id AND e.type = 'state_changed'),
              v.created_at
            ) AS state_entered_at,
            COALESCE(
              (SELECT array_agg(s.sent_at ORDER BY s.sent_at DESC) FROM auto_email_sends s
               WHERE s.auto_email_id = $1 AND s.valuation_id = v.id),
              '{}'
            ) AS prior_sends_at,
            -- Sparse and default-on, like the rest of the matrix: no row means
            -- consent. COALESCE, not a join filter, so a user with no
            -- preferences row is still a candidate.
            COALESCE(
              (SELECT np.email FROM notification_preferences np
                WHERE np.user_id = v.user_id AND np.event_type = 'marketing'),
              true
            ) AS marketing_email
     FROM valuations v
     JOIN users u ON u.id = v.user_id
     LEFT JOIN partners p ON p.id = v.partner_id
     WHERE v.archived_at IS NULL AND u.deleted_at IS NULL
       AND v.state = $2 AND ${conditionSql[campaign.condition] ?? 'false'} ${cursorSql}
     ORDER BY v.id ASC
     LIMIT $3`,
    params,
  );
  return rows;
}

/**
 * Rows per page of the drip scan's candidate set.
 *
 * The query above used to have no LIMIT at all — the last unbounded read on a
 * job path. It is a scan rather than a request, and it holds the auto-email
 * advisory lock while it runs, so it was a memory ceiling rather than a
 * correctness bug: every valuation in a campaign's trigger state, with four
 * correlated subqueries' worth of columns attached, materialised in this
 * process at once. It grows with the table, and the failure mode is a
 * heap-exhausted service rather than a slow one.
 *
 * 500 is the same order as the other bounded scans here (the pipeline reaper's
 * 100, the retention sweep's 500, the monitor page's own limit) and is far
 * above any plausible per-campaign backlog, so an ordinary pass still reads one
 * page.
 */
export const AUTO_EMAIL_PAGE_LIMIT = 500;

/**
 * Every candidate for a campaign, a page at a time.
 *
 * Keyset on `v.id` for the reason `eachEnabledMonitor` spells out: a
 * `timestamptz` cursor loses microseconds on the way through JavaScript and
 * stops advancing. A ULID cursor is also stable under the writes the scan makes
 * as it goes — each pass inserts `auto_email_sends` rows, which the
 * `prior_sends_at` subquery reads, so a page's contents depend on what earlier
 * pages did. Ordering by id means a valuation is visited exactly once whatever
 * those writes changed, which an OFFSET page could not promise.
 *
 * Paged rather than capped: a campaign whose backlog exceeds one page must
 * still reach everyone in it. A cap would leave the tail of the queue unmailed
 * and report a healthy `queued` count for the head.
 */
export async function* eachDueCandidate(
  db: pg.Pool | pg.PoolClient,
  campaign: AutoEmailRow,
  opts: { pageSize?: number } = {},
): AsyncGenerator<DueCandidate[]> {
  const size = Math.min(Math.max(opts.pageSize ?? AUTO_EMAIL_PAGE_LIMIT, 1), AUTO_EMAIL_PAGE_LIMIT);
  let after: string | null = null;
  for (;;) {
    const rows: DueCandidate[] = await dueCandidates(db, campaign, { limit: size, after });
    if (rows.length > 0) yield rows;
    if (rows.length < size) return;
    after = rows[rows.length - 1]!.valuation_id;
  }
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
