import { describe, expect, it } from 'vitest';
import {
  PROGRESS_STAGES,
  HALTED_STATES,
  stageIndexOf,
  REQUIRED_DOCUMENT_KINDS,
  CLIENT_TIMELINE_EVENTS,
} from '../../src/domain/progress.js';
import { VALUATION_STATES } from '../../src/domain/valuation.js';

describe('PROGRESS_STAGES', () => {
  it('has 5 stages in order', () => {
    expect(PROGRESS_STAGES.length).toBe(5);
    expect(PROGRESS_STAGES.map((s) => s.key)).toEqual([
      'setup',
      'documents',
      'analysis',
      'draft',
      'delivered',
    ]);
  });

  it('every stage has a label and description', () => {
    for (const stage of PROGRESS_STAGES) {
      expect(stage.label.length).toBeGreaterThan(0);
      expect(stage.description.length).toBeGreaterThan(0);
    }
  });

  it('covers all non-halted valuation states', () => {
    const coveredStates = PROGRESS_STAGES.flatMap((s) => [...s.states]);
    for (const state of VALUATION_STATES) {
      if (HALTED_STATES.has(state)) continue;
      expect(coveredStates).toContain(state);
    }
  });

  it('does not include halted states', () => {
    const coveredStates = new Set(PROGRESS_STAGES.flatMap((s) => [...s.states]));
    for (const halted of HALTED_STATES) {
      expect(coveredStates.has(halted)).toBe(false);
    }
  });
});

describe('HALTED_STATES', () => {
  it('contains cancelled, timeout, ignored', () => {
    expect(HALTED_STATES.has('cancelled')).toBe(true);
    expect(HALTED_STATES.has('timeout')).toBe(true);
    expect(HALTED_STATES.has('ignored')).toBe(true);
  });

  it('does not contain active states', () => {
    expect(HALTED_STATES.has('pending')).toBe(false);
    expect(HALTED_STATES.has('published')).toBe(false);
  });
});

describe('stageIndexOf', () => {
  it('returns 0 for setup states', () => {
    expect(stageIndexOf('pending')).toBe(0);
    expect(stageIndexOf('started')).toBe(0);
  });

  it('returns 1 for document states', () => {
    expect(stageIndexOf('onboarding_completed')).toBe(1);
    expect(stageIndexOf('user_finished')).toBe(1);
  });

  it('returns 2 for analysis states', () => {
    expect(stageIndexOf('completed')).toBe(2);
    expect(stageIndexOf('review')).toBe(2);
    expect(stageIndexOf('reviewed')).toBe(2);
  });

  it('returns 3 for draft states', () => {
    expect(stageIndexOf('drafted')).toBe(3);
    expect(stageIndexOf('draft_changes')).toBe(3);
    expect(stageIndexOf('draft_accepted')).toBe(3);
  });

  it('returns 4 for delivered', () => {
    expect(stageIndexOf('published')).toBe(4);
  });

  it('returns -1 for halted states', () => {
    expect(stageIndexOf('cancelled')).toBe(-1);
    expect(stageIndexOf('timeout')).toBe(-1);
    expect(stageIndexOf('ignored')).toBe(-1);
  });
});

describe('REQUIRED_DOCUMENT_KINDS', () => {
  it('has at least 5 required document types', () => {
    expect(REQUIRED_DOCUMENT_KINDS.length).toBeGreaterThanOrEqual(5);
  });

  it('each entry has kind and label', () => {
    for (const doc of REQUIRED_DOCUMENT_KINDS) {
      expect(doc.kind.length).toBeGreaterThan(0);
      expect(doc.label.length).toBeGreaterThan(0);
    }
  });

  it('includes cap_table', () => {
    expect(REQUIRED_DOCUMENT_KINDS.some((d) => d.kind === 'cap_table')).toBe(true);
  });
});

describe('CLIENT_TIMELINE_EVENTS', () => {
  it('maps event types to human-readable labels', () => {
    expect(CLIENT_TIMELINE_EVENTS['valuation_created']).toBe('Valuation created');
    expect(CLIENT_TIMELINE_EVENTS['document_uploaded']).toBe('Document uploaded');
  });
});
