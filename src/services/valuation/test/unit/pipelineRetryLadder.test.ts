import { describe, expect, it } from 'vitest';
import {
  PIPELINE_RETRY_BACKOFF_MINUTES,
  PIPELINE_MAX_ATTEMPTS,
  PIPELINE_JITTER_FLOOR,
  pipelineRetryDelayMinutes,
  pipelineRetryWindowMs,
} from '../../src/domain/pipelineRetry.js';

describe('pipelineRetryDelayMinutes', () => {
  it('returns the first backoff step after the first failure', () => {
    expect(pipelineRetryDelayMinutes(1)).toBe(PIPELINE_RETRY_BACKOFF_MINUTES[0]);
  });

  it('walks through each step of the ladder', () => {
    for (let i = 0; i < PIPELINE_RETRY_BACKOFF_MINUTES.length; i++) {
      expect(pipelineRetryDelayMinutes(i + 1)).toBe(PIPELINE_RETRY_BACKOFF_MINUTES[i]);
    }
  });

  it('returns null when max attempts exhausted', () => {
    expect(pipelineRetryDelayMinutes(PIPELINE_MAX_ATTEMPTS)).toBeNull();
    expect(pipelineRetryDelayMinutes(PIPELINE_MAX_ATTEMPTS + 1)).toBeNull();
  });

  it('handles sub-1 or non-finite attempts by returning the first step', () => {
    expect(pipelineRetryDelayMinutes(0)).toBe(PIPELINE_RETRY_BACKOFF_MINUTES[0]);
    expect(pipelineRetryDelayMinutes(-1)).toBe(PIPELINE_RETRY_BACKOFF_MINUTES[0]);
    expect(pipelineRetryDelayMinutes(NaN)).toBe(PIPELINE_RETRY_BACKOFF_MINUTES[0]);
    expect(pipelineRetryDelayMinutes(Infinity)).toBe(PIPELINE_RETRY_BACKOFF_MINUTES[0]);
  });

  it('holds at the longest step when maxAttempts exceeds the ladder', () => {
    const lastStep = PIPELINE_RETRY_BACKOFF_MINUTES.at(-1);
    const extraAttempts = PIPELINE_RETRY_BACKOFF_MINUTES.length + 1;
    expect(pipelineRetryDelayMinutes(extraAttempts, extraAttempts + 2)).toBe(lastStep);
  });

  it('respects a custom maxAttempts below the ladder length', () => {
    expect(pipelineRetryDelayMinutes(2, 2)).toBeNull();
    expect(pipelineRetryDelayMinutes(1, 2)).toBe(PIPELINE_RETRY_BACKOFF_MINUTES[0]);
  });
});

describe('pipelineRetryWindowMs', () => {
  it('returns a window bounded by the jitter floor', () => {
    const window = pipelineRetryWindowMs(1);
    expect(window).not.toBeNull();
    const stepMs = PIPELINE_RETRY_BACKOFF_MINUTES[0]! * 60_000;
    expect(window!.minMs).toBe(stepMs * PIPELINE_JITTER_FLOOR);
    expect(window!.maxMs).toBe(stepMs);
  });

  it('returns null when attempts are exhausted', () => {
    expect(pipelineRetryWindowMs(PIPELINE_MAX_ATTEMPTS)).toBeNull();
  });

  it('keeps min strictly less than max at every step', () => {
    for (let i = 1; i < PIPELINE_MAX_ATTEMPTS; i++) {
      const window = pipelineRetryWindowMs(i);
      expect(window).not.toBeNull();
      expect(window!.minMs).toBeLessThan(window!.maxMs);
    }
  });
});

describe('ladder constants', () => {
  it('has exactly five backoff steps', () => {
    expect(PIPELINE_RETRY_BACKOFF_MINUTES).toHaveLength(5);
  });

  it('max attempts is steps + 1 (the initial attempt)', () => {
    expect(PIPELINE_MAX_ATTEMPTS).toBe(PIPELINE_RETRY_BACKOFF_MINUTES.length + 1);
  });

  it('backoff steps are monotonically increasing', () => {
    for (let i = 1; i < PIPELINE_RETRY_BACKOFF_MINUTES.length; i++) {
      expect(PIPELINE_RETRY_BACKOFF_MINUTES[i]).toBeGreaterThan(
        PIPELINE_RETRY_BACKOFF_MINUTES[i - 1]!,
      );
    }
  });

  it('jitter floor is 0.5 (equal jitter)', () => {
    expect(PIPELINE_JITTER_FLOOR).toBe(0.5);
  });
});
