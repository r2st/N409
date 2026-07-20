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
