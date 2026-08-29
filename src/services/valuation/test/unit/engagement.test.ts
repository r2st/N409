import { describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_STAGES,
  ENGAGEMENT_STAGE_KEYS,
  isEngagementStage,
  isTerminalStage,
  nextStage,
  planStageTransition,
  slaStatus,
  stageDurations,
} from '../../src/domain/engagement.js';

const HOUR = 3_600_000;

describe('engagement', () => {
  it('has an ordered set of stages ending in complete', () => {
    expect(ENGAGEMENT_STAGES[0]!.key).toBe('kickoff');
    expect(ENGAGEMENT_STAGES[ENGAGEMENT_STAGES.length - 1]!.key).toBe('complete');
  });

  describe('nextStage', () => {
    it('advances through the pipeline', () => {
      expect(nextStage('kickoff')?.key).toBe('data_collection');
      expect(nextStage('final_report')?.key).toBe('board_approval');
    });
    it('returns null at the terminal stage', () => {
      expect(nextStage('complete')).toBeNull();
      expect(nextStage('unknown')).toBeNull();
    });
  });

  it('isEngagementStage validates keys', () => {
    expect(isEngagementStage('analysis')).toBe(true);
    expect(isEngagementStage('nope')).toBe(false);
  });

  /**
   * The transition table, enumerated. Every state × every kind of move, so a
   * stage added to `ENGAGEMENT_STAGES` cannot quietly acquire a rule nobody
   * chose — the "every non-terminal stage" cases below are driven off the list
   * itself rather than spelled out.
   */
  describe('planStageTransition', () => {
    const NON_TERMINAL = ENGAGEMENT_STAGE_KEYS.filter((k) => !isTerminalStage(k));

    it('marks exactly one stage terminal', () => {
      expect(ENGAGEMENT_STAGE_KEYS.filter((k) => isTerminalStage(k))).toEqual(['complete']);
      expect(isTerminalStage('nope')).toBe(false);
    });

    it('takes an unnamed target to be the next stage in order', () => {
      for (const from of NON_TERMINAL) {
        expect(planStageTransition(from, undefined)).toEqual({
          ok: true,
          from,
          to: nextStage(from)!.key,
          reopen: false,
        });
      }
    });

    it('refuses an unnamed target at the terminal stage', () => {
      expect(planStageTransition('complete', undefined)).toEqual({
        ok: false,
        reason: 'already_final',
      });
    });

    it('refuses a target that is not a stage', () => {
      for (const to of ['nonsense', '', 'COMPLETE', 'kickoff ']) {
        expect(planStageTransition('analysis', to)).toEqual({ ok: false, reason: 'unknown_stage' });
      }
    });

    it('refuses a move to the stage the engagement is already in', () => {
      for (const from of ENGAGEMENT_STAGE_KEYS) {
        expect(planStageTransition(from, from)).toEqual({ ok: false, reason: 'same_stage' });
      }
    });

    /**
     * Skipping and going backwards are both allowed between working stages: an
     * engagement that bounces between client review and drafting is ordinary,
     * and the trail is built to record a stage being re-entered.
     */
    it('allows any move between non-terminal stages, in either direction', () => {
      for (const from of NON_TERMINAL) {
        for (const to of NON_TERMINAL) {
          if (from === to) continue;
          expect(planStageTransition(from, to)).toEqual({ ok: true, from, to, reopen: false });
        }
      }
    });

    it('allows completing from any working stage, without asking to reopen', () => {
      for (const from of NON_TERMINAL) {
        expect(planStageTransition(from, 'complete')).toEqual({
          ok: true,
          from,
          to: 'complete',
          reopen: false,
        });
      }
    });

    /**
     * The half of the table that was missing. `terminal: true` was honoured on
     * the unnamed-target path and ignored on the named one, so a finished
     * engagement could be walked back to kickoff by picking a line in a select
     * box — back onto the pipeline board, back into the overdue sweep, and
     * recorded as an ordinary forward step.
     */
    it('refuses to leave the terminal stage unless the caller says it is a reopen', () => {
      for (const to of NON_TERMINAL) {
        expect(planStageTransition('complete', to)).toEqual({ ok: false, reason: 'reopen_required' });
        expect(planStageTransition('complete', to, { reopen: false })).toEqual({
          ok: false,
          reason: 'reopen_required',
        });
        expect(planStageTransition('complete', to, { reopen: true })).toEqual({
          ok: true,
          from: 'complete',
          to,
          reopen: true,
        });
      }
    });

    it('does not let the flag excuse a refusal it has nothing to do with', () => {
      expect(planStageTransition('complete', undefined, { reopen: true })).toEqual({
        ok: false,
        reason: 'already_final',
      });
      expect(planStageTransition('analysis', 'nonsense', { reopen: true })).toEqual({
        ok: false,
        reason: 'unknown_stage',
      });
      expect(planStageTransition('analysis', 'analysis', { reopen: true })).toEqual({
        ok: false,
        reason: 'same_stage',
      });
    });

    /**
     * A stage key the code no longer knows — a row left behind by a stage that
     * was renamed or dropped. It is not terminal, so the engagement can be
     * moved back onto a stage that exists; that is the recovery path, and it
     * must not need a flag that describes something else.
     */
    it('lets an engagement stranded on an unknown stage be moved back onto a real one', () => {
      expect(planStageTransition('retired_stage_name', 'analysis')).toEqual({
        ok: true,
        from: 'retired_stage_name',
        to: 'analysis',
        reopen: false,
      });
      expect(planStageTransition('retired_stage_name', undefined)).toEqual({
        ok: false,
        reason: 'already_final',
      });
    });
  });

  describe('slaStatus', () => {
    const entered = new Date('2026-01-01T00:00:00Z');
    it('is green well within the SLA', () => {
      // data_collection SLA = 120h; 10h in.
      const s = slaStatus('data_collection', entered, new Date(entered.getTime() + 10 * HOUR));
      expect(s.level).toBe('green');
      expect(s.overdue).toBe(false);
    });
    it('is yellow past 75% of the SLA', () => {
      const s = slaStatus('data_collection', entered, new Date(entered.getTime() + 100 * HOUR));
      expect(s.level).toBe('yellow');
      expect(s.overdue).toBe(false);
    });
    it('is red and overdue past the SLA', () => {
      const s = slaStatus('data_collection', entered, new Date(entered.getTime() + 130 * HOUR));
      expect(s.level).toBe('red');
      expect(s.overdue).toBe(true);
      expect(s.dueAt).toBe(new Date(entered.getTime() + 120 * HOUR).toISOString());
    });
    it('is always green for the terminal stage', () => {
      const s = slaStatus('complete', entered, new Date(entered.getTime() + 1000 * HOUR));
      expect(s.level).toBe('green');
      expect(s.overdue).toBe(false);
      expect(s.dueAt).toBeNull();
    });
  });

  describe('stageDurations', () => {
    it('computes actual vs expected per stage and flags breaches', () => {
      const t0 = new Date('2026-01-01T00:00:00Z');
      const history = [
        { stage: 'kickoff', entered_at: t0 }, // SLA 24h
        { stage: 'data_collection', entered_at: new Date(t0.getTime() + 48 * HOUR) },
      ];
      const now = new Date(t0.getTime() + 60 * HOUR);
      const durations = stageDurations(history, now);
      // kickoff took 48h vs 24h SLA → breach
      expect(durations[0]).toMatchObject({ stage: 'kickoff', actualHours: 48, breachedSla: true });
      // data_collection open 12h so far, no breach
      expect(durations[1]).toMatchObject({
        stage: 'data_collection',
        actualHours: 12,
        breachedSla: false,
        exitedAt: null,
      });
    });
  });
});
