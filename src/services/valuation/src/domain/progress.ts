import type { ValuationState } from './valuation.js';
import type { DocumentKind } from './pipeline.js';

/**
 * Client-portal progress model (IMPROVEMENTS_RESEARCH §5.6): the internal
 * 14-state workflow collapsed into the five stages a client actually cares
 * about. Pure mapping — the route layer adds timestamps and the checklist.
 */

export interface ProgressStage {
  key: 'setup' | 'documents' | 'analysis' | 'draft' | 'delivered';
  label: string;
  description: string;
  states: readonly ValuationState[];
}

export const PROGRESS_STAGES: readonly ProgressStage[] = [
  {
    key: 'setup',
    label: 'Getting started',
    description: 'Engagement created and onboarding underway.',
    states: ['pending', 'started'],
  },
  {
    key: 'documents',
    label: 'Document collection',
    description: 'We gather your cap table, financials and projections.',
    states: ['onboarding_completed', 'user_finished'],
  },
  {
    key: 'analysis',
    label: 'Analysis & review',
    description: 'Our analysts run the valuation and review the results.',
    states: ['completed', 'review', 'reviewed'],
  },
  {
    key: 'draft',
    label: 'Draft report',
    description: 'A draft report is shared for your review.',
    states: ['drafted', 'draft_changes', 'draft_accepted'],
  },
  {
    key: 'delivered',
    label: 'Final delivery',
    description: 'The signed report is published and ready to download.',
    states: ['published'],
  },
] as const;

/** States that halt the engagement instead of progressing it. */
export const HALTED_STATES: ReadonlySet<ValuationState> = new Set([
  'cancelled',
  'timeout',
  'ignored',
]);

/** Index of the stage a state belongs to, or -1 for halted states. */
export function stageIndexOf(state: ValuationState): number {
  return PROGRESS_STAGES.findIndex((s) => (s.states as readonly string[]).includes(state));
}

/** Documents a defensible valuation needs (mirrors the AI service checklist). */
export const REQUIRED_DOCUMENT_KINDS: ReadonlyArray<{ kind: DocumentKind; label: string }> = [
  { kind: 'cap_table', label: 'Capitalization table' },
  { kind: 'income_statement', label: 'Income statement / P&L' },
  { kind: 'balance_sheet', label: 'Balance sheet' },
  { kind: 'projections', label: 'Financial projections' },
  { kind: 'articles_of_incorporation', label: 'Articles of incorporation' },
  { kind: 'option_grants', label: 'Option grants / equity plan' },
];

/** Event types a client may see on their timeline, with friendly labels. */
export const CLIENT_TIMELINE_EVENTS: Readonly<Record<string, string>> = {
  valuation_created: 'Valuation created',
  document_uploaded: 'Document uploaded',
  state_changed: 'Stage updated',
  report_rendered: 'Report generated',
  scenario_saved: 'Scenario saved',
};

export type ProgressStageKey = ProgressStage['key'];

/**
 * Percentage the bar shows on *entering* each stage. Not linear on purpose:
 * document collection is the longest wall-clock stage but the least "done",
 * and clients read a bar that sits at 20% for a week as broken. The gap
 * between `documents` and `analysis` is filled in by checklist progress so the
 * bar keeps moving while the client is actually doing something.
 */
export const STAGE_START_PERCENT: Readonly<Record<ProgressStageKey, number>> = {
  setup: 5,
  documents: 20,
  analysis: 50,
  draft: 80,
  delivered: 100,
};

/** Typical calendar days spent in each stage — the basis of the delivery ETA. */
export const TYPICAL_STAGE_DAYS: Readonly<Record<ProgressStageKey, number>> = {
  setup: 1,
  documents: 5,
  analysis: 3,
  draft: 2,
  delivered: 0,
};

/**
 * Overall completion 0–100. Inside document collection the checklist drives
 * the sub-progress; every other stage reports its entry percentage, because
 * the client has no visibility into how far along an analyst actually is.
 */
export function percentComplete(args: {
  stageIndex: number;
  documentsUploaded: number;
  documentsRequired: number;
}): number {
  const { stageIndex, documentsUploaded, documentsRequired } = args;
  if (stageIndex < 0) return 0;
  const stage = PROGRESS_STAGES[Math.min(stageIndex, PROGRESS_STAGES.length - 1)]!;
  const base = STAGE_START_PERCENT[stage.key];
  if (stage.key !== 'documents' || documentsRequired <= 0) return base;

  const span = STAGE_START_PERCENT.analysis - STAGE_START_PERCENT.documents;
  const ratio = Math.min(1, Math.max(0, documentsUploaded / documentsRequired));
  return Math.round(base + span * ratio);
}

export type NextActionKey =
  | 'contact_support'
  | 'download_report'
  | 'review_draft'
  | 'upload_documents'
  | 'respond_to_request'
  | 'awaiting_us';

export interface NextAction {
  key: NextActionKey;
  label: string;
  detail: string;
  /** Workspace tab the call-to-action should link to, or null for none. */
  tab: string | null;
  /** Whether the ball is in the client's court. */
  client_action_required: boolean;
}

/**
 * The single next thing the client should do. Precedence matters: a halted
 * engagement overrides everything, a ready report beats an outstanding
 * checklist (they can still upload later), and "we're working on it" is the
 * honest default rather than inventing busywork.
 */
export function nextClientAction(args: {
  halted: boolean;
  stageIndex: number;
  waitingOnClient: boolean;
  missingDocuments: number;
  reportAvailable: boolean;
}): NextAction {
  const { halted, stageIndex, waitingOnClient, missingDocuments, reportAvailable } = args;

  if (halted) {
    return {
      key: 'contact_support',
      label: 'Contact support',
      detail: 'This valuation is not progressing. Get in touch and we will pick it back up.',
      tab: null,
      client_action_required: true,
    };
  }
  if (reportAvailable && stageIndex >= 4) {
    return {
      key: 'download_report',
      label: 'Download your report',
      detail: 'Your final valuation report is ready.',
      tab: 'report',
      client_action_required: false,
    };
  }
  if (stageIndex === 3) {
    return {
      key: 'review_draft',
      label: 'Review the draft report',
      detail: 'Read the draft and either accept it or tell us what to change.',
      tab: 'report',
      client_action_required: true,
    };
  }
  if (missingDocuments > 0) {
    return {
      key: 'upload_documents',
      label: `Upload ${missingDocuments} remaining document${missingDocuments === 1 ? '' : 's'}`,
      detail: 'We cannot finish the analysis until the checklist is complete.',
      tab: 'documents',
      client_action_required: true,
    };
  }
  if (waitingOnClient) {
    return {
      key: 'respond_to_request',
      label: 'Respond to our request',
      detail: 'We have asked you a question — check your messages to keep things moving.',
      tab: 'engagement',
      client_action_required: true,
    };
  }
  return {
    key: 'awaiting_us',
    label: 'Nothing needed from you',
    detail: 'Our analysts are working on your valuation. We will be in touch.',
    tab: null,
    client_action_required: false,
  };
}

const MS_PER_DAY = 86_400_000;

/** Whole days between two instants, floored at 0. */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/**
 * Projected delivery date: today plus the remaining stages' typical durations.
 * Null once delivered or when the engagement is halted — an ETA on a stalled
 * valuation is worse than no ETA.
 */
export function estimatedDeliveryAt(args: {
  stageIndex: number;
  halted: boolean;
  now: Date;
}): Date | null {
  const { stageIndex, halted, now } = args;
  if (halted || stageIndex < 0 || stageIndex >= PROGRESS_STAGES.length - 1) return null;
  const remaining = PROGRESS_STAGES.slice(stageIndex).reduce(
    (days, stage) => days + TYPICAL_STAGE_DAYS[stage.key],
    0,
  );
  return new Date(now.getTime() + remaining * MS_PER_DAY);
}

/**
 * Days spent in each stage: the gap to the next stage's entry, or to `now` for
 * the stage still in progress. Stages never entered report null.
 */
export function stageDurations(
  enteredAt: ReadonlyMap<number, Date>,
  now: Date,
): Array<number | null> {
  return PROGRESS_STAGES.map((_, index) => {
    const start = enteredAt.get(index);
    if (!start) return null;
    let end: Date | undefined;
    for (let next = index + 1; next < PROGRESS_STAGES.length; next += 1) {
      const candidate = enteredAt.get(next);
      if (candidate) {
        end = candidate;
        break;
      }
    }
    return daysBetween(start, end ?? now);
  });
}
