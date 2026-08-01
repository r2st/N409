import { describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_STAGES,
  isEngagementStage,
  nextStage,
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
