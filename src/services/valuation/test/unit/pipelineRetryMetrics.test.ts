import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import {
  registerPipelineRetryMetrics,
  resetPipelineRetryMetrics,
  recordPipelineRetryOutcome,
} from '../../src/observability/pipelineRetryMetrics.js';

describe('pipeline retry metrics (R451, M11)', () => {
  afterEach(() => resetPipelineRetryMetrics());

  it('counts every outcome the retry sweep can reach', () => {
    const registry = new MetricsRegistry();
    registerPipelineRetryMetrics(registry);

    recordPipelineRetryOutcome('resumed');
    recordPipelineRetryOutcome('resumed');
    recordPipelineRetryOutcome('skipped_retired');
    recordPipelineRetryOutcome('skipped_opted_out');
    recordPipelineRetryOutcome('skipped_deleted');
    recordPipelineRetryOutcome('stranded');

    const text = registry.render();
    expect(text).toContain('pipeline_retry_outcomes_total{outcome="resumed"} 2');
    expect(text).toContain('pipeline_retry_outcomes_total{outcome="skipped_retired"} 1');
    expect(text).toContain('pipeline_retry_outcomes_total{outcome="skipped_opted_out"} 1');
    expect(text).toContain('pipeline_retry_outcomes_total{outcome="skipped_deleted"} 1');
    expect(text).toContain('pipeline_retry_outcomes_total{outcome="stranded"} 1');
  });

  it('is silent before registration', () => {
    expect(() => recordPipelineRetryOutcome('resumed')).not.toThrow();
  });
});
