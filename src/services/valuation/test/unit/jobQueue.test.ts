import { describe, expect, it } from 'vitest';
import {
  ACTIVE_JOB_STATUSES,
  JOB_SOURCES,
  JOB_SOURCE_LABELS,
  JOB_STATUSES,
  JOB_STATUS_MAP,
  normalizeJobStatus,
  summarizeJobStats,
  type JobStats,
} from '../../src/domain/jobQueue.js';

describe('job status normalization', () => {
  it('labels every source', () => {
    for (const source of JOB_SOURCES) expect(JOB_SOURCE_LABELS[source]).toBeTruthy();
  });

  it('maps every native status onto the common scale', () => {
    for (const source of JOB_SOURCES) {
      for (const [native, common] of Object.entries(JOB_STATUS_MAP[source])) {
        expect(JOB_STATUSES, `${source}.${native} → ${common}`).toContain(common);
        expect(normalizeJobStatus(source, native)).toBe(common);
      }
    }
  });

  it('keeps each queue’s vocabulary distinct where it differs', () => {
    // `pending` is a webhook's word for pre-work and `queued` is the outbox's;
    // a single flat map would have hidden which table each came from.
    expect(normalizeJobStatus('webhook_delivery', 'pending')).toBe('queued');
    expect(normalizeJobStatus('email', 'queued')).toBe('queued');
    expect(normalizeJobStatus('pipeline_run', 'extracting')).toBe('running');
    expect(normalizeJobStatus('pipeline_run', 'calculating')).toBe('running');
    expect(normalizeJobStatus('pipeline_run', 'ready')).toBe('succeeded');
    expect(normalizeJobStatus('email', 'sent')).toBe('succeeded');
    expect(normalizeJobStatus('webhook_delivery', 'delivered')).toBe('succeeded');
  });

  it('keeps skipped out of both success and failure', () => {
    // An outbox row is skipped when notification preferences say not to send.
    // That is the system working, and "sent" would answer a support question
    // wrongly.
    expect(normalizeJobStatus('email', 'skipped')).toBe('skipped');
    const totals = summarizeJobStats([{ source: 'email', status: 'skipped', count: 4 }]);
    expect(totals).toEqual({ active: 0, failed: 0, succeeded: 0, skipped: 4 });
  });

  it('treats an unmapped status as in flight rather than throwing', () => {
    // A status this file has not heard of means a table grew a state. In
    // flight puts it on the default filter where somebody notices; `failed`
    // would page someone over a deployment ordering problem and `succeeded`
    // would hide a queue that had stopped.
    expect(normalizeJobStatus('ai_job', 'throttled')).toBe('running');
    expect(ACTIVE_JOB_STATUSES).toContain('running');
  });

  it('has no in-flight state for calculations', () => {
    // The row is written once the engine has returned.
    expect(Object.values(JOB_STATUS_MAP.calculation)).toEqual(['succeeded', 'failed']);
  });
});

describe('job stat rollups', () => {
  const stats: JobStats[] = [
    { source: 'email', status: 'queued', count: 2 },
    { source: 'email', status: 'sent' as never, count: 0 },
    { source: 'ai_job', status: 'running', count: 3 },
    { source: 'ai_job', status: 'failed', count: 1 },
    { source: 'pipeline_run', status: 'succeeded', count: 40 },
    { source: 'webhook_delivery', status: 'skipped', count: 5 },
  ];

  it('rolls queued and running together as outstanding work', () => {
    expect(summarizeJobStats(stats)).toEqual({ active: 5, failed: 1, succeeded: 40, skipped: 5 });
  });

  it('rolls up one source at a time for the per-queue header', () => {
    expect(summarizeJobStats(stats.filter((s) => s.source === 'ai_job'))).toEqual({
      active: 3,
      failed: 1,
      succeeded: 0,
      skipped: 0,
    });
  });

  it('reports zeros for an idle queue rather than nothing', () => {
    expect(summarizeJobStats([])).toEqual({ active: 0, failed: 0, succeeded: 0, skipped: 0 });
  });
});
