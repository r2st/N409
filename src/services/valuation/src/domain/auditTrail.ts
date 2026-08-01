import { toCsv } from '../export/csv.js';

/**
 * Audit-trail enrichment over the raw `valuation_events` spine.
 *
 * The spine stores what happened; this module says what it *means* — a stable
 * catalog mapping every event type to a human label, a category, a severity and
 * a visibility, plus the payload normalisation that turns the several payload
 * shapes we write ({ changes }, { from, to }, { fields }, …) into one flat list
 * of field-level changes. Pure functions only, so the whole audit vocabulary is
 * unit-testable and can be reused by the report, the evidence bundle and the
 * client portal without dragging the database along.
 */

export const EVENT_CATEGORIES = [
  'lifecycle',
  'documents',
  'methodology',
  'data',
  'analysis',
  'review',
  'output',
  'access',
  'integration',
  'other',
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/**
 * How much an event matters when reconstructing why a number moved.
 * `critical` events are the ones an auditor must be able to explain: they
 * change the concluded value, the methodology behind it, or the deliverable.
 */
export const EVENT_SEVERITIES = ['info', 'notice', 'critical'] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

/** `internal` events are analyst tooling — never shown outside ops. */
export type EventVisibility = 'client' | 'internal';

export interface EventDescriptor {
  label: string;
  category: EventCategory;
  severity: EventSeverity;
  visibility: EventVisibility;
}

const D = (
  label: string,
  category: EventCategory,
  severity: EventSeverity,
  visibility: EventVisibility = 'internal',
): EventDescriptor => ({ label, category, severity, visibility });

/**
 * Every event type the platform writes to `valuation_events`. Keep in sync with
 * the *_EVENT_TYPES constant maps; `auditTrail.test.ts` asserts the catalog
 * covers all of them so a new event type cannot silently fall through to the
 * unknown-event fallback.
 */
export const EVENT_CATALOG: Readonly<Record<string, EventDescriptor>> = {
  // ── Lifecycle ───────────────────────────────────────────────────────────
  valuation_created: D('Valuation created', 'lifecycle', 'notice', 'client'),
  valuation_updated: D('Valuation details updated', 'lifecycle', 'notice', 'client'),
  valuation_cloned: D('Valuation cloned', 'lifecycle', 'notice'),
  valuation_completed: D('Valuation completed', 'lifecycle', 'critical', 'client'),
  state_changed: D('Stage changed', 'lifecycle', 'notice', 'client'),
  engagement_started: D('Engagement started', 'lifecycle', 'info', 'client'),
  engagement_stage_advanced: D('Engagement stage advanced', 'lifecycle', 'info', 'client'),
  engagement_analyst_assigned: D('Analyst assigned', 'lifecycle', 'info'),
  engagement_overdue_reminder: D('Overdue reminder sent', 'lifecycle', 'info'),

  // ── Documents & intake ──────────────────────────────────────────────────
  document_uploaded: D('Document uploaded', 'documents', 'notice', 'client'),
  document_deleted: D('Document deleted', 'documents', 'notice', 'client'),
  document_reminder_sent: D('Document reminder sent', 'documents', 'info', 'client'),
  intake_saved: D('Intake saved', 'documents', 'info', 'client'),
  intake_submitted: D('Intake submitted', 'documents', 'notice', 'client'),
  company_profile_updated: D('Company profile updated', 'documents', 'notice', 'client'),

  // ── Methodology & assumptions ───────────────────────────────────────────
  params_updated: D('Methodology parameters changed', 'methodology', 'critical'),
  methodology_decision_recorded: D('Methodology decision recorded', 'methodology', 'critical'),
  overwrite_applied: D('Analyst overwrite applied', 'methodology', 'critical'),
  overwrite_reverted: D('Analyst overwrite reverted', 'methodology', 'critical'),
  scenario_saved: D('Scenario saved', 'methodology', 'notice', 'client'),
  scenario_deleted: D('Scenario deleted', 'methodology', 'notice', 'client'),

  // ── Underlying data ─────────────────────────────────────────────────────
  cap_table_imported: D('Cap table imported', 'data', 'critical', 'client'),
  cap_table_change: D('Cap table changed', 'data', 'critical', 'client'),
  transaction_added: D('Transaction added', 'data', 'critical'),
  transaction_updated: D('Transaction updated', 'data', 'critical'),
  transaction_deleted: D('Transaction deleted', 'data', 'critical'),
  funding_round: D('Funding round recorded', 'data', 'critical'),
  funding_round_added: D('Funding round added', 'data', 'critical'),
  funding_round_updated: D('Funding round updated', 'data', 'critical'),
  funding_round_deleted: D('Funding round deleted', 'data', 'critical'),
  grant_issued: D('Option grant issued', 'data', 'notice'),
  grant_updated: D('Option grant updated', 'data', 'notice'),
  grant_cancelled: D('Option grant cancelled', 'data', 'notice'),
  revenue_change: D('Revenue changed materially', 'data', 'critical'),
  workbook_updated: D('Workbook edited', 'data', 'notice'),

  // ── Analysis & automation ───────────────────────────────────────────────
  calculation_completed: D('Calculation completed', 'analysis', 'critical', 'client'),
  ai_job_completed: D('AI job completed', 'analysis', 'info'),
  auto_pipeline_started: D('Automated pipeline started', 'analysis', 'info'),
  auto_pipeline_failed: D('Automated pipeline failed', 'analysis', 'notice'),
  auto_pipeline_toggled: D('Automated pipeline toggled', 'analysis', 'info'),
  health_checks_run: D('Health checks run', 'analysis', 'info'),

  // ── Review & approval ───────────────────────────────────────────────────
  review_task_created: D('Review task created', 'review', 'info'),
  review_task_updated: D('Review task updated', 'review', 'info'),
  review_needed: D('Review requested', 'review', 'notice'),
  review_decision: D('Review decision recorded', 'review', 'critical'),
  qa_review_completed: D('QA review completed', 'review', 'critical'),
  changes_requested: D('Changes requested', 'review', 'notice', 'client'),
  comment_added: D('Comment added', 'review', 'info'),
  board_member_added: D('Board member added', 'review', 'notice'),
  board_member_removed: D('Board member removed', 'review', 'notice'),
  board_resolution_generated: D('Board resolution generated', 'review', 'notice', 'client'),
  board_resolution_sent: D('Board resolution sent', 'review', 'notice', 'client'),
  board_resolution_approved: D('Board resolution approved', 'review', 'critical', 'client'),
  board_resolution_rejected: D('Board resolution rejected', 'review', 'critical', 'client'),
  board_signoff_recorded: D('Board sign-off recorded', 'review', 'critical', 'client'),

  // ── Output & delivery ───────────────────────────────────────────────────
  report_saved: D('Report draft saved', 'output', 'notice'),
  report_reverted: D('Report reverted', 'output', 'critical'),
  report_rendered: D('Report generated', 'output', 'critical', 'client'),
  draft_ready: D('Draft ready for review', 'output', 'notice', 'client'),
  evidence_bundle_exported: D('Evidence bundle exported', 'output', 'notice'),

  // ── Access & integration ────────────────────────────────────────────────
  email_received: D('Email received', 'access', 'info'),
  monitoring_enabled: D('Monitoring enabled', 'integration', 'info', 'client'),
  monitoring_disabled: D('Monitoring disabled', 'integration', 'info', 'client'),
  monitoring_trigger_fired: D('Monitoring trigger fired', 'integration', 'notice', 'client'),
};

const UNKNOWN_EVENT: EventDescriptor = D('Event recorded', 'other', 'info');

/** Catalog lookup that never throws — unknown types degrade to a safe default. */
export function describeEventType(type: string): EventDescriptor {
  return EVENT_CATALOG[type] ?? UNKNOWN_EVENT;
}

// ── Field-level change extraction ─────────────────────────────────────────

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** True for `{ from, to }` change records as written by patch helpers. */
function isChangeRecord(value: unknown): value is { from?: unknown; to?: unknown } {
  return typeof value === 'object' && value !== null && ('from' in value || 'to' in value);
}

/**
 * Diff two records over an allow-list of columns, producing exactly the
 * `{ field: { from, to } }` payload shape the patch helpers record. Values are
 * compared with `!==`, matching how the SQL patch builders decide what to write.
 */
export function diffRecords(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  columns: readonly string[],
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const column of columns) {
    if (!(column in after)) continue;
    if (before[column] === after[column]) continue;
    changes[column] = { from: before[column] ?? null, to: after[column] };
  }
  return changes;
}

/**
 * Normalise the payload shapes we write into one flat change list:
 *   - `{ changes: { field: { from, to } } }` — patchValuation / patchParams
 *   - `{ from, to }`                          — state_changed
 *   - `{ engine_inputs_applied: { … } }`      — AI extraction auto-apply
 *   - `{ fields: ['a', 'b'] }`                — grants and friends (names only)
 * Anything else yields an empty list rather than guessing.
 */
export function extractChanges(type: string, payload: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];

  const nested = payload.changes;
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    for (const [field, value] of Object.entries(nested as Record<string, unknown>)) {
      if (isChangeRecord(value)) {
        changes.push({ field, from: value.from ?? null, to: value.to ?? null });
      } else {
        changes.push({ field, from: null, to: value });
      }
    }
  }

  if (changes.length === 0 && ('from' in payload || 'to' in payload)) {
    const field = type === 'state_changed' ? 'state' : 'value';
    changes.push({ field, from: payload.from ?? null, to: payload.to ?? null });
  }

  const applied = payload.engine_inputs_applied;
  if (typeof applied === 'object' && applied !== null && !Array.isArray(applied)) {
    for (const [field, value] of Object.entries(applied as Record<string, unknown>)) {
      changes.push({ field: `engine_inputs.${field}`, from: null, to: value });
    }
  }

  if (changes.length === 0 && Array.isArray(payload.fields)) {
    for (const field of payload.fields) {
      if (typeof field === 'string') changes.push({ field, from: null, to: null });
    }
  }

  return changes;
}

/** Compact, human-readable rendering of a value for audit summaries. */
export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  return 'updated';
}

/** Field name → the words a reader expects (`dlom` → `DLOM`). */
export function humanizeField(field: string): string {
  const [prefix, ...rest] = field.split('.');
  const leaf = rest.length > 0 ? rest.join('.') : prefix!;
  const words = leaf
    .replace(/_cents$/, '')
    .split('_')
    .filter(Boolean)
    .map((w) => (/^(dlom|dloc|opm|qsbs|ytd|ai|qa|id)$/i.test(w) ? w.toUpperCase() : w));
  if (words.length === 0) return field;
  const first = words[0]!;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

/** One-line summary of what an event changed, for timelines and PDF exports. */
export function summarizeChanges(changes: readonly FieldChange[], max = 3): string {
  if (changes.length === 0) return '';
  const shown = changes.slice(0, max).map((c) => {
    const name = humanizeField(c.field);
    if (c.from === null && c.to === null) return name;
    if (c.from === null || c.from === undefined) return `${name} set to ${formatAuditValue(c.to)}`;
    return `${name}: ${formatAuditValue(c.from)} → ${formatAuditValue(c.to)}`;
  });
  const extra = changes.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ');
}

// ── Enriched entries ──────────────────────────────────────────────────────

export interface RawAuditEvent {
  id: string;
  seq: string;
  type: string;
  actor_type: string;
  actor_id: string | null;
  source: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export interface AuditEntry extends EventDescriptor {
  id: string;
  seq: string;
  type: string;
  actor_type: string;
  actor_id: string | null;
  source: string | null;
  changes: FieldChange[];
  summary: string;
  occurred_at: Date;
}

/** Raw spine row → enriched, renderable audit entry. */
export function describeEvent(event: RawAuditEvent): AuditEntry {
  const descriptor = describeEventType(event.type);
  const changes = extractChanges(event.type, event.payload ?? {});
  return {
    id: event.id,
    seq: event.seq,
    type: event.type,
    ...descriptor,
    actor_type: event.actor_type,
    actor_id: event.actor_id,
    source: event.source,
    changes,
    summary: summarizeChanges(changes),
    occurred_at: event.occurred_at,
  };
}

export interface AuditFilters {
  category?: EventCategory;
  severity?: EventSeverity;
  actorType?: string;
  type?: string;
  field?: string;
  from?: Date;
  to?: Date;
  /** Non-ops callers only ever see client-visible events. */
  includeInternal: boolean;
}

/** Apply the visibility rule and every optional filter, newest first. */
export function filterAuditEntries(entries: readonly AuditEntry[], filters: AuditFilters): AuditEntry[] {
  return entries
    .filter((e) => {
      if (!filters.includeInternal && e.visibility !== 'client') return false;
      if (filters.category && e.category !== filters.category) return false;
      if (filters.severity && e.severity !== filters.severity) return false;
      if (filters.actorType && e.actor_type !== filters.actorType) return false;
      if (filters.type && e.type !== filters.type) return false;
      if (filters.field && !e.changes.some((c) => c.field === filters.field)) return false;
      if (filters.from && e.occurred_at < filters.from) return false;
      if (filters.to && e.occurred_at > filters.to) return false;
      return true;
    })
    .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime() || (a.seq < b.seq ? 1 : -1));
}

export interface AuditSummary {
  total: number;
  by_category: Record<string, number>;
  by_severity: Record<string, number>;
  by_actor_type: Record<string, number>;
  critical_changes: number;
  changed_fields: string[];
  first_at: Date | null;
  last_at: Date | null;
}

/** Roll-up used by the audit-trail header and the evidence bundle cover page. */
export function summarizeAuditTrail(entries: readonly AuditEntry[]): AuditSummary {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byActor: Record<string, number> = {};
  const fields = new Set<string>();
  let critical = 0;
  let first: Date | null = null;
  let last: Date | null = null;

  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
    bySeverity[entry.severity] = (bySeverity[entry.severity] ?? 0) + 1;
    byActor[entry.actor_type] = (byActor[entry.actor_type] ?? 0) + 1;
    if (entry.severity === 'critical') critical += 1;
    for (const change of entry.changes) fields.add(change.field);
    if (first === null || entry.occurred_at < first) first = entry.occurred_at;
    if (last === null || entry.occurred_at > last) last = entry.occurred_at;
  }

  return {
    total: entries.length,
    by_category: byCategory,
    by_severity: bySeverity,
    by_actor_type: byActor,
    critical_changes: critical,
    changed_fields: [...fields].sort(),
    first_at: first,
    last_at: last,
  };
}

/**
 * Per-field change history, newest first — answers "how did DLOM get to 22%?"
 * in one lookup instead of scanning the whole timeline.
 */
export function fieldHistory(
  entries: readonly AuditEntry[],
  field: string,
): Array<FieldChange & { at: Date; actor_type: string; actor_id: string | null; type: string }> {
  const history: Array<
    FieldChange & { at: Date; actor_type: string; actor_id: string | null; type: string }
  > = [];
  for (const entry of entries) {
    for (const change of entry.changes) {
      if (change.field !== field) continue;
      history.push({
        ...change,
        at: entry.occurred_at,
        actor_type: entry.actor_type,
        actor_id: entry.actor_id,
        type: entry.type,
      });
    }
  }
  return history.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * Flat change log: one row per field that moved, across the whole spine.
 * events.json is the authoritative record but it is nested JSON; an auditor
 * scanning for "when did the DLOM change and who signed off?" wants a table
 * they can open in Excel and sort. Same data, readable shape.
 */
export function changeLogCsv(entries: readonly AuditEntry[]): string {
  const rows = entries.flatMap((entry) =>
    entry.changes.map((change) => [
      entry.occurred_at,
      entry.seq,
      entry.type,
      entry.label,
      entry.category,
      entry.severity,
      entry.actor_type,
      entry.actor_id ?? '',
      entry.source ?? '',
      change.field,
      humanizeField(change.field),
      formatAuditValue(change.from),
      formatAuditValue(change.to),
    ]),
  );
  return toCsv(
    [
      'occurred_at',
      'seq',
      'event_type',
      'event',
      'category',
      'severity',
      'actor_type',
      'actor_id',
      'source',
      'field',
      'field_label',
      'from',
      'to',
    ],
    rows,
  );
}
