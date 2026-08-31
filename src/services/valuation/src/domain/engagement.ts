import { isOps } from '../auth/rbac.js';
import type { RoleKey } from './roles.js';

/**
 * Engagement lifecycle model (feature 8). An engagement is the operational
 * overlay on a valuation: the stages an analyst moves it through, each with an
 * SLA. Pure functions — no I/O, callers pass `now` — so SLA/overdue logic is
 * deterministic and testable.
 */

export const ENGAGEMENT_EVENT_TYPES = {
  started: 'engagement_started',
  stageAdvanced: 'engagement_stage_advanced',
  analystAssigned: 'engagement_analyst_assigned',
  overdueReminded: 'engagement_overdue_reminder',
  reopened: 'engagement_reopened',
} as const;

export interface EngagementStage {
  key: string;
  label: string;
  /** Target hours to spend in this stage before it is considered overdue. */
  slaHours: number;
  terminal?: boolean;
}

export const ENGAGEMENT_STAGES: readonly EngagementStage[] = [
  { key: 'kickoff', label: 'Kickoff', slaHours: 24 },
  { key: 'data_collection', label: 'Data collection', slaHours: 120 },
  { key: 'analysis', label: 'Analysis', slaHours: 72 },
  { key: 'draft_report', label: 'Draft report', slaHours: 48 },
  { key: 'client_review', label: 'Client review', slaHours: 120 },
  { key: 'auditor_queries', label: 'Auditor queries', slaHours: 72 },
  { key: 'final_report', label: 'Final report', slaHours: 24 },
  { key: 'board_approval', label: 'Board approval', slaHours: 120 },
  { key: 'complete', label: 'Complete', slaHours: 0, terminal: true },
] as const;

export const ENGAGEMENT_STAGE_KEYS: readonly string[] = ENGAGEMENT_STAGES.map((s) => s.key);

export function isEngagementStage(key: string): boolean {
  return ENGAGEMENT_STAGE_KEYS.includes(key);
}

export function stageByKey(key: string): EngagementStage | undefined {
  return ENGAGEMENT_STAGES.find((s) => s.key === key);
}

export function stageIndex(key: string): number {
  return ENGAGEMENT_STAGES.findIndex((s) => s.key === key);
}

/** The stage after `key`, or null if already terminal / unknown. */
export function nextStage(key: string): EngagementStage | null {
  const i = stageIndex(key);
  if (i < 0 || i >= ENGAGEMENT_STAGES.length - 1) return null;
  return ENGAGEMENT_STAGES[i + 1]!;
}

/**
 * Whether `key` names a stage the pipeline is finished at.
 *
 * A stage carrying `terminal: true` is the end of the engagement: the pipeline
 * board stops listing it, the SLA stops running, and the overdue sweep stops
 * chasing the analyst. Read by {@link planStageTransition}, which is the only
 * place the flag has ever meant anything to a *write* — see the note there.
 */
export function isTerminalStage(key: string): boolean {
  return stageByKey(key)?.terminal === true;
}

export type StageTransitionRefusal =
  /** The body named something that is not a stage. */
  | 'unknown_stage'
  /** No target given and there is nothing after the current stage. */
  | 'already_final'
  /** The engagement is already where the caller is asking it to go. */
  | 'same_stage'
  /** Leaving a terminal stage, without saying that is what this is. */
  | 'reopen_required';

export type StageTransitionPlan =
  { ok: true; from: string; to: string; reopen: boolean } | { ok: false; reason: StageTransitionRefusal };

/**
 * The whole transition table of the engagement lifecycle, as one pure decision.
 *
 * It used to be four `if`s in the route, and the reason to pull them out is
 * that they did not agree with each other. `terminal: true` on `complete` was
 * enforced on exactly one of the two paths into this function: an advance with
 * no target asked `nextStage`, got null and refused with "already at its final
 * stage", while an advance naming a target never consulted the flag at all. So
 * `POST /engagement/advance {}` on a finished engagement was a 409 and `POST
 * /engagement/advance {"stage":"kickoff"}` was a 200 — and the second one is
 * the consequential direction. Reopening puts the engagement back on the
 * pipeline board and back into the overdue-reminder sweep, which then emails
 * the assigned analyst about work everybody believed was delivered. The stage
 * trail recorded it as an ordinary `engagement_stage_advanced`, indistinguish-
 * able from the forward move that closed it. The UI offered the move, too: the
 * "Jump to stage" picker lists every stage, `complete` included, from every
 * stage, `complete` included.
 *
 * Reopening is legitimate ops work — an auditor comes back with queries a month
 * after the board approved — so the fix is not to forbid it. It is to make it
 * something the caller *says*, rather than something that happens because a
 * select box had the option in it. `reopen: true` is the whole difference, and
 * a reopen records its own event so the trail can be read back.
 *
 * Backwards moves between non-terminal stages stay unguarded on purpose: an
 * engagement that bounces between client review and drafting is the normal
 * case, and `engagement_stage_history` is built to record a stage being
 * re-entered.
 */
export function planStageTransition(
  from: string,
  to: string | undefined,
  opts: { reopen?: boolean } = {},
): StageTransitionPlan {
  let target = to;
  if (target === undefined) {
    const next = nextStage(from);
    // An implicit advance never reopens: there is no stage after the last one,
    // and "next" is not a word for going backwards.
    if (!next) return { ok: false, reason: 'already_final' };
    target = next.key;
  }
  if (!isEngagementStage(target)) return { ok: false, reason: 'unknown_stage' };
  if (target === from) return { ok: false, reason: 'same_stage' };
  const reopen = isTerminalStage(from);
  if (reopen && opts.reopen !== true) return { ok: false, reason: 'reopen_required' };
  return { ok: true, from, to: target, reopen };
}

/**
 * Whether the analyst assigned to an engagement is still somebody the overdue
 * sweep may chase.
 *
 * The assignment is checked once, at the moment it is made:
 * `assertAssignableAnalyst` refuses a non-existent id, refuses a client, and
 * refuses a suspended account, and the reason it gives is the sweep — "the
 * overdue sweep emails whoever is assigned, by name, with the company and the
 * internal SLA state, so a mis-assignment sends one client's engagement status
 * to an unrelated one". Nothing asked the question again afterwards, and every
 * fact it rests on is one an administrator changes on a different screen:
 *
 *   * The account is closed. `deleted_at` is this platform's soft delete for a
 *     user; the console's deactivation and SCIM's `active: false` both set it,
 *     and every other reader of `users` filters on it — the roster, the
 *     reviewer picker, password reset, the auto-email drip
 *     (`repos/communications.ts`, which says so at length). This join did not,
 *     so a closed account went on receiving a daily email naming a client and
 *     that client's internal SLA state, at an address the platform had just
 *     finished cutting off from everything else. That is the one thing
 *     deactivating it was supposed to stop.
 *   * The account is suspended, or is no longer on the operations team.
 *     `ignored` subtracts every privilege the row otherwise carries, and roles
 *     can simply be taken away; either way the assigned analyst can no longer
 *     open the engagement the mail is chasing them about.
 *
 * Asked through `isOps` rather than re-spelled in SQL, so this stays the same
 * predicate the assign route enforces rather than a second copy of it that can
 * drift. Null roles is the LEFT JOIN's "nobody is assigned" — and an account
 * with no roles at all is not ops either, so both fall out the same way.
 */
export function analystIsChasable<
  T extends {
    analyst_email: string | null;
    analyst_deleted_at: Date | null;
    analyst_roles: RoleKey[] | null;
    analyst_partner_id: string | null;
    assigned_analyst_id: string | null;
  },
>(analyst: T): analyst is T & { analyst_email: string; assigned_analyst_id: string } {
  if (!analyst.assigned_analyst_id || !analyst.analyst_email) return false;
  if (analyst.analyst_deleted_at !== null) return false;
  return isOps({
    id: analyst.assigned_analyst_id,
    roles: analyst.analyst_roles ?? [],
    partnerId: analyst.analyst_partner_id,
  });
}

export type SlaLevel = 'green' | 'yellow' | 'red';

export interface SlaStatus {
  stage: string;
  label: string;
  expectedHours: number;
  elapsedHours: number;
  dueAt: string | null;
  overdue: boolean;
  level: SlaLevel;
}

const MS_PER_HOUR = 3_600_000;

/**
 * SLA status for the current stage. Terminal stages (complete) are always
 * green. Otherwise: green under 75% of the SLA, yellow up to the SLA, red once
 * over. `enteredAt` is when the stage began.
 */
export function slaStatus(stageKey: string, enteredAt: Date, now: Date): SlaStatus {
  const stage = stageByKey(stageKey) ?? { key: stageKey, label: stageKey, slaHours: 0, terminal: true };
  const elapsedHours = Math.max(0, (now.getTime() - enteredAt.getTime()) / MS_PER_HOUR);
  if (stage.terminal || stage.slaHours <= 0) {
    return {
      stage: stage.key,
      label: stage.label,
      expectedHours: stage.slaHours,
      elapsedHours: Math.round(elapsedHours * 10) / 10,
      dueAt: null,
      overdue: false,
      level: 'green',
    };
  }
  const dueAt = new Date(enteredAt.getTime() + stage.slaHours * MS_PER_HOUR);
  const overdue = elapsedHours > stage.slaHours;
  const level: SlaLevel = overdue ? 'red' : elapsedHours > stage.slaHours * 0.75 ? 'yellow' : 'green';
  return {
    stage: stage.key,
    label: stage.label,
    expectedHours: stage.slaHours,
    elapsedHours: Math.round(elapsedHours * 10) / 10,
    dueAt: dueAt.toISOString(),
    overdue,
    level,
  };
}

export interface StageHistoryEntry {
  stage: string;
  entered_at: Date;
}

export interface StageDuration {
  stage: string;
  label: string;
  enteredAt: string;
  exitedAt: string | null;
  actualHours: number;
  expectedHours: number;
  breachedSla: boolean;
}

/**
 * Expected-vs-actual duration per stage from the ordered history. The final
 * (still-open) stage uses `now` as its exit for the elapsed calculation.
 */
export function stageDurations(history: StageHistoryEntry[], now: Date): StageDuration[] {
  const ordered = [...history].sort((a, b) => a.entered_at.getTime() - b.entered_at.getTime());
  return ordered.map((entry, i) => {
    const exited = ordered[i + 1]?.entered_at ?? null;
    const end = exited ?? now;
    const actualHours = Math.max(0, (end.getTime() - entry.entered_at.getTime()) / MS_PER_HOUR);
    const stage = stageByKey(entry.stage);
    const expectedHours = stage?.slaHours ?? 0;
    return {
      stage: entry.stage,
      label: stage?.label ?? entry.stage,
      enteredAt: entry.entered_at.toISOString(),
      exitedAt: exited ? exited.toISOString() : null,
      actualHours: Math.round(actualHours * 10) / 10,
      expectedHours,
      breachedSla: expectedHours > 0 && actualHours > expectedHours,
    };
  });
}
