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
