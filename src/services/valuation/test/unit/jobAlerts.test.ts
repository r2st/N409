import { describe, expect, it } from 'vitest';
import {
  evaluateJobAlerts,
  humanMinutes,
  observeQueues,
  type JobAlertRule,
  type QueueObservation,
} from '../../src/domain/jobAlerts.js';
import { JOB_SOURCES, type JobStats } from '../../src/domain/jobQueue.js';

/**
 * When a queue is in trouble (design §17.1 item 13).
 *
 * The claim the whole feature rests on is in the first test below: a count
 * cannot tell a busy queue from a stopped one, and the age of the oldest
 * outstanding job can. Everything else here is threshold arithmetic.
 */

const NOW = new Date('2026-08-08T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

const rule = (over: Partial<JobAlertRule> = {}): JobAlertRule => ({
  source: 'email',
  enabled: true,
  stall_minutes: 120,
  failure_count: 10,
  failure_window_hours: 24,
  ...over,
});

const queue = (over: Partial<QueueObservation> = {}): QueueObservation => ({
  source: 'email',
  oldestActiveAt: null,
  active: 0,
  failed: 0,
  ...over,
});

describe('evaluateJobAlerts — stalled', () => {
  it('tells a busy queue from a stopped one', () => {
    // Five hundred queued messages, all of them minutes old: a Monday morning.
    const busy = queue({ active: 500, oldestActiveAt: minutesAgo(4) });
    expect(evaluateJobAlerts([busy], [rule()], NOW)).toEqual([]);

    // One message, queued since Thursday: a dead transport. The count is 500×
    // smaller and this is the one that matters.
    const stopped = queue({ active: 1, oldestActiveAt: minutesAgo(60 * 30) });
    const findings = evaluateJobAlerts([stopped], [rule()], NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'stalled', threshold: 120 });
    expect(findings[0]!.detail).toContain('waiting 1d 6h');
  });

  it('does not fire exactly at the threshold', () => {
    const at = queue({ active: 1, oldestActiveAt: minutesAgo(120) });
    expect(evaluateJobAlerts([at], [rule({ stall_minutes: 120 })], NOW)).toEqual([]);
    const past = queue({ active: 1, oldestActiveAt: minutesAgo(121) });
    expect(evaluateJobAlerts([past], [rule({ stall_minutes: 120 })], NOW)).toHaveLength(1);
  });

  it('says nothing about an empty queue', () => {
    // Nothing outstanding is not "infinitely old"; it is nothing to do.
    expect(evaluateJobAlerts([queue()], [rule()], NOW)).toEqual([]);
  });
});

describe('evaluateJobAlerts — failing', () => {
  it('catches a queue that is moving fine and getting everything wrong', () => {
    // Nothing outstanding — the age check cannot see this at all, because a
    // failed job is not owed.
    const failing = queue({ failed: 12, oldestActiveAt: null });
    const findings = evaluateJobAlerts([failing], [rule({ failure_count: 10 })], NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'failing', observed: 12, threshold: 10 });
  });

  it('fires at the threshold, not one past it', () => {
    expect(evaluateJobAlerts([queue({ failed: 10 })], [rule({ failure_count: 10 })], NOW)).toHaveLength(1);
    expect(evaluateJobAlerts([queue({ failed: 9 })], [rule({ failure_count: 10 })], NOW)).toEqual([]);
  });

  it('reports both conditions when both are true', () => {
    const bad = queue({ failed: 40, active: 3, oldestActiveAt: minutesAgo(600) });
    const kinds = evaluateJobAlerts([bad], [rule()], NOW).map((f) => f.kind);
    expect(kinds.sort()).toEqual(['failing', 'stalled']);
  });
});

describe('evaluateJobAlerts — rules', () => {
  it('produces nothing for a disabled rule, so the reconciler closes its alert', () => {
    const bad = queue({ failed: 99, active: 9, oldestActiveAt: minutesAgo(9_000) });
    expect(evaluateJobAlerts([bad], [rule({ enabled: false })], NOW)).toEqual([]);
  });

  it('produces nothing for a queue with no rule at all', () => {
    const bad = queue({ source: 'ai_job', failed: 99, active: 9, oldestActiveAt: minutesAgo(9_000) });
    expect(evaluateJobAlerts([bad], [rule({ source: 'email' })], NOW)).toEqual([]);
  });
});

describe('observeQueues', () => {
  const stats: JobStats[] = [
    { source: 'email', status: 'queued', count: 4 },
    { source: 'email', status: 'running', count: 2 },
    { source: 'email', status: 'failed', count: 7 },
    { source: 'email', status: 'skipped', count: 30 },
    { source: 'ai_job', status: 'succeeded', count: 11 },
  ];

  it('folds the per-status counts into active and failed', () => {
    const email = observeQueues(JOB_SOURCES, stats, [
      { source: 'email', oldest_due_at: minutesAgo(30), active: 6 },
    ]).find((o) => o.source === 'email')!;
    expect(email.active).toBe(6);
    expect(email.failed).toBe(7);
  });

  it('does not count skipped as failed', () => {
    // A skipped outbox row is the notification-preference matrix working.
    const email = observeQueues(JOB_SOURCES, stats, []).find((o) => o.source === 'email')!;
    expect(email.failed).toBe(7);
  });

  it('returns every source, including the ones with no rows', () => {
    // "Nothing has run all day" has to be distinguishable from "healthy", and
    // a dropped source would read as the second.
    const seen = observeQueues(JOB_SOURCES, stats, []).map((o) => o.source);
    expect(seen).toEqual([...JOB_SOURCES]);
    const calculation = observeQueues(JOB_SOURCES, stats, []).find((o) => o.source === 'calculation')!;
    expect(calculation).toMatchObject({ active: 0, failed: 0, oldestActiveAt: null });
  });
});

describe('humanMinutes', () => {
  it('reads the way an operator reads a queue age', () => {
    expect(humanMinutes(18)).toBe('18m');
    expect(humanMinutes(60)).toBe('1h');
    expect(humanMinutes(252)).toBe('4h 12m');
    expect(humanMinutes(60 * 24)).toBe('1d');
    expect(humanMinutes(60 * 30)).toBe('1d 6h');
  });
});
