import { describe, expect, it } from 'vitest';
import {
  PROGRESS_STAGES,
  HALTED_STATES,
  STAGE_START_PERCENT,
  TYPICAL_STAGE_DAYS,
  stageIndexOf,
  REQUIRED_DOCUMENT_KINDS,
  CLIENT_TIMELINE_EVENTS,
  daysBetween,
  estimatedDeliveryAt,
  nextClientAction,
  percentComplete,
  stageDurations,
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

const REQUIRED = REQUIRED_DOCUMENT_KINDS.length;

describe('STAGE_START_PERCENT', () => {
  it('covers every stage', () => {
    for (const stage of PROGRESS_STAGES) {
      expect(STAGE_START_PERCENT[stage.key]).toBeTypeOf('number');
    }
  });

  it('increases monotonically and ends at 100', () => {
    const values = PROGRESS_STAGES.map((s) => STAGE_START_PERCENT[s.key]);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
    expect(values.at(-1)).toBe(100);
  });
});

describe('TYPICAL_STAGE_DAYS', () => {
  it('covers every stage with a non-negative estimate', () => {
    for (const stage of PROGRESS_STAGES) {
      expect(TYPICAL_STAGE_DAYS[stage.key]).toBeGreaterThanOrEqual(0);
    }
  });

  it('costs nothing once delivered', () => {
    expect(TYPICAL_STAGE_DAYS.delivered).toBe(0);
  });
});

describe('percentComplete', () => {
  it('is 0 for halted valuations', () => {
    expect(percentComplete({ stageIndex: -1, documentsUploaded: 3, documentsRequired: REQUIRED })).toBe(0);
  });

  it('reports the stage entry percentage outside document collection', () => {
    expect(percentComplete({ stageIndex: 0, documentsUploaded: 0, documentsRequired: REQUIRED })).toBe(
      STAGE_START_PERCENT.setup,
    );
    expect(percentComplete({ stageIndex: 2, documentsUploaded: 0, documentsRequired: REQUIRED })).toBe(
      STAGE_START_PERCENT.analysis,
    );
    expect(percentComplete({ stageIndex: 4, documentsUploaded: 0, documentsRequired: REQUIRED })).toBe(100);
  });

  it('fills the documents stage from the checklist', () => {
    const empty = percentComplete({
      stageIndex: 1,
      documentsUploaded: 0,
      documentsRequired: REQUIRED,
    });
    const half = percentComplete({
      stageIndex: 1,
      documentsUploaded: Math.floor(REQUIRED / 2),
      documentsRequired: REQUIRED,
    });
    const full = percentComplete({
      stageIndex: 1,
      documentsUploaded: REQUIRED,
      documentsRequired: REQUIRED,
    });
    expect(empty).toBe(STAGE_START_PERCENT.documents);
    expect(half).toBeGreaterThan(empty);
    expect(full).toBe(STAGE_START_PERCENT.analysis);
  });

  it('never exceeds the next stage when extra documents are uploaded', () => {
    expect(percentComplete({ stageIndex: 1, documentsUploaded: 99, documentsRequired: REQUIRED })).toBe(
      STAGE_START_PERCENT.analysis,
    );
  });

  it('does not divide by zero when nothing is required', () => {
    expect(percentComplete({ stageIndex: 1, documentsUploaded: 0, documentsRequired: 0 })).toBe(
      STAGE_START_PERCENT.documents,
    );
  });

  it('clamps a stage index past the last stage', () => {
    expect(percentComplete({ stageIndex: 99, documentsUploaded: 0, documentsRequired: REQUIRED })).toBe(100);
  });

  it('always returns 0–100', () => {
    for (let stageIndex = -1; stageIndex < PROGRESS_STAGES.length; stageIndex += 1) {
      for (let uploaded = 0; uploaded <= REQUIRED; uploaded += 1) {
        const value = percentComplete({
          stageIndex,
          documentsUploaded: uploaded,
          documentsRequired: REQUIRED,
        });
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('nextClientAction', () => {
  const base = {
    halted: false,
    stageIndex: 1,
    waitingOnClient: false,
    missingDocuments: 0,
    reportAvailable: false,
  };

  it('sends halted engagements to support, overriding everything else', () => {
    const action = nextClientAction({
      ...base,
      halted: true,
      missingDocuments: 3,
      reportAvailable: true,
      stageIndex: 4,
    });
    expect(action.key).toBe('contact_support');
    expect(action.client_action_required).toBe(true);
  });

  it('offers the report once delivered', () => {
    const action = nextClientAction({ ...base, stageIndex: 4, reportAvailable: true });
    expect(action.key).toBe('download_report');
    expect(action.client_action_required).toBe(false);
    expect(action.tab).toBe('report');
  });

  it('does not offer a report that is not available yet', () => {
    expect(nextClientAction({ ...base, stageIndex: 4, reportAvailable: false }).key).not.toBe(
      'download_report',
    );
  });

  it('asks for a draft review in the draft stage', () => {
    const action = nextClientAction({ ...base, stageIndex: 3, missingDocuments: 2 });
    expect(action.key).toBe('review_draft');
  });

  /**
   * The draft stage covers three states and only one of them is the client's
   * turn. Asking someone to review a draft they have already accepted — or to
   * respond to revisions they themselves requested — is a call-to-action for
   * work that is finished, and it stays on their dashboard until we publish.
   */
  describe('inside the draft stage', () => {
    it('asks for the review while the draft is out for one', () => {
      const action = nextClientAction({ ...base, stageIndex: 3, state: 'drafted' });
      expect(action.key).toBe('review_draft');
      expect(action.client_action_required).toBe(true);
    });

    it('stops asking once the client has accepted', () => {
      const action = nextClientAction({ ...base, stageIndex: 3, state: 'draft_accepted' });
      expect(action.key).toBe('awaiting_us');
      expect(action.client_action_required).toBe(false);
    });

    it('stops asking while we are making the changes they asked for', () => {
      const action = nextClientAction({ ...base, stageIndex: 3, state: 'draft_changes' });
      expect(action.key).toBe('awaiting_us');
      expect(action.client_action_required).toBe(false);
    });

    it('still surfaces a question we have put to them', () => {
      const action = nextClientAction({
        ...base,
        stageIndex: 3,
        state: 'draft_accepted',
        waitingOnClient: true,
      });
      expect(action.key).toBe('respond_to_request');
    });

    it('does not fall through to a document nag once the analysis is done', () => {
      // The checklist is six kinds wide and rarely fully ticked; "we cannot
      // finish the analysis until it is complete" is false by the draft stage.
      const action = nextClientAction({
        ...base,
        stageIndex: 3,
        state: 'draft_accepted',
        missingDocuments: 3,
      });
      expect(action.key).toBe('awaiting_us');
    });

    it('keeps its old meaning when no state is supplied', () => {
      expect(nextClientAction({ ...base, stageIndex: 3 }).key).toBe('review_draft');
    });
  });

  it('asks for missing documents, pluralised', () => {
    expect(nextClientAction({ ...base, missingDocuments: 1 }).label).toContain('1 remaining document');
    expect(nextClientAction({ ...base, missingDocuments: 3 }).label).toContain('3 remaining documents');
  });

  it('prefers a complete checklist over a pending question', () => {
    const action = nextClientAction({ ...base, missingDocuments: 2, waitingOnClient: true });
    expect(action.key).toBe('upload_documents');
  });

  it('falls back to responding when nothing is missing but we are waiting', () => {
    expect(nextClientAction({ ...base, waitingOnClient: true }).key).toBe('respond_to_request');
  });

  it('says nothing is needed when the ball is with us', () => {
    const action = nextClientAction({ ...base, stageIndex: 2 });
    expect(action.key).toBe('awaiting_us');
    expect(action.client_action_required).toBe(false);
    expect(action.tab).toBeNull();
  });

  it('always returns a non-empty label and detail', () => {
    for (const stageIndex of [-1, 0, 1, 2, 3, 4]) {
      for (const halted of [true, false]) {
        const action = nextClientAction({ ...base, stageIndex, halted });
        expect(action.label.length).toBeGreaterThan(0);
        expect(action.detail.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-04T12:00:00Z'))).toBe(3);
  });

  it('floors at zero for reversed inputs', () => {
    expect(daysBetween(new Date('2026-01-04T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toBe(0);
  });
});

describe('estimatedDeliveryAt', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('is null when halted', () => {
    expect(estimatedDeliveryAt({ stageIndex: 1, halted: true, now })).toBeNull();
  });

  it('is null once delivered', () => {
    expect(estimatedDeliveryAt({ stageIndex: 4, halted: false, now })).toBeNull();
  });

  it('is null for an unknown stage', () => {
    expect(estimatedDeliveryAt({ stageIndex: -1, halted: false, now })).toBeNull();
  });

  it('sums the remaining stages', () => {
    const expected = TYPICAL_STAGE_DAYS.analysis + TYPICAL_STAGE_DAYS.draft;
    const eta = estimatedDeliveryAt({ stageIndex: 2, halted: false, now })!;
    expect(eta.getTime() - now.getTime()).toBe(expected * 86_400_000);
  });

  it('gets nearer as the valuation advances', () => {
    const early = estimatedDeliveryAt({ stageIndex: 0, halted: false, now })!;
    const late = estimatedDeliveryAt({ stageIndex: 3, halted: false, now })!;
    expect(late.getTime()).toBeLessThan(early.getTime());
  });
});

describe('stageDurations', () => {
  const now = new Date('2026-01-11T00:00:00Z');

  it('returns null for stages never entered', () => {
    const durations = stageDurations(new Map(), now);
    expect(durations).toEqual([null, null, null, null, null]);
  });

  it('measures a finished stage against the next entry', () => {
    const entered = new Map([
      [0, new Date('2026-01-01T00:00:00Z')],
      [1, new Date('2026-01-04T00:00:00Z')],
    ]);
    const durations = stageDurations(entered, now);
    expect(durations[0]).toBe(3);
  });

  it('measures the current stage against now', () => {
    const entered = new Map([[1, new Date('2026-01-04T00:00:00Z')]]);
    expect(stageDurations(entered, now)[1]).toBe(7);
  });

  it('skips over stages that were never entered', () => {
    const entered = new Map([
      [0, new Date('2026-01-01T00:00:00Z')],
      [3, new Date('2026-01-06T00:00:00Z')],
    ]);
    const durations = stageDurations(entered, now);
    expect(durations[0]).toBe(5);
    expect(durations[1]).toBeNull();
    expect(durations[3]).toBe(5);
  });

  it('returns one entry per stage', () => {
    expect(stageDurations(new Map(), now)).toHaveLength(PROGRESS_STAGES.length);
  });
});
