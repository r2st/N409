import { describe, expect, it } from 'vitest';
import {
  EMAIL_JITTER_FLOOR,
  EMAIL_MAX_ATTEMPTS,
  EMAIL_RETRY_BACKOFF_MINUTES,
  emailRetryDelayMinutes,
  emailRetryWindowMs,
} from '../../src/domain/emailRetry.js';
import { WEBHOOK_RETRY_BACKOFF_MINUTES } from '../../src/domain/partnerWebhooks.js';

/**
 * The outbox's retry schedule, as a shape rather than as five numbers.
 *
 * The property that matters is not any single step — it is that the ladder
 * *reaches*. The fault this closed was five attempts spent at one fixed
 * cadence, all of them inside the outage that caused them, so the assertions
 * below are about growth and reach, and only one of them names a figure.
 */
describe('email retry ladder', () => {
  it('grows with each attempt rather than repeating one cadence', () => {
    const delays = Array.from({ length: EMAIL_MAX_ATTEMPTS - 1 }, (_, i) => emailRetryDelayMinutes(i + 1));
    expect(delays.every((d) => d !== null)).toBe(true);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!, `step ${i} must not be shorter than step ${i - 1}`).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it('reaches past an overnight outage, which the flat cadence did not', () => {
    // The old behaviour: EMAIL_RETRY_SCAN_MINUTES (30) × 4 remaining attempts,
    // i.e. every attempt spent inside two hours. Anything longer than a
    // business morning is the whole point of the change.
    const totalMinutes = EMAIL_RETRY_BACKOFF_MINUTES.reduce((a, b) => a + b, 0);
    expect(totalMinutes).toBeGreaterThan(8 * 60);
  });

  it('is terminal at the ceiling, and only there', () => {
    expect(emailRetryDelayMinutes(EMAIL_MAX_ATTEMPTS - 1)).not.toBeNull();
    expect(emailRetryDelayMinutes(EMAIL_MAX_ATTEMPTS)).toBeNull();
    expect(emailRetryDelayMinutes(EMAIL_MAX_ATTEMPTS + 10)).toBeNull();
  });

  it('holds at the longest step when the ceiling is raised past the ladder', () => {
    // A raised EMAIL_RETRY_MAX_ATTEMPTS has to add attempts. Falling through to
    // "terminal" past the end of the array would make the extra attempts
    // configuration that silently does nothing.
    const last = EMAIL_RETRY_BACKOFF_MINUTES.at(-1)!;
    const beyond = emailRetryDelayMinutes(EMAIL_MAX_ATTEMPTS + 2, EMAIL_MAX_ATTEMPTS + 5);
    expect(beyond).toBe(last);
  });

  it('treats a nonsensical attempt count as a first attempt rather than as terminal', () => {
    // Defensive: a row read back with a null/NaN counter must land at the
    // bottom of the ladder, not be quietly written off as out of attempts.
    for (const bad of [0, -1, Number.NaN]) {
      expect(emailRetryDelayMinutes(bad)).toBe(EMAIL_RETRY_BACKOFF_MINUTES[0]);
    }
  });

  it('agrees with the webhook ladder, which answers the same question', () => {
    // Two ladders for the same kind of upstream would be two things to reason
    // about during an incident with no argument for either. If one is ever
    // deliberately re-tuned, this is the line that says so out loud.
    expect(EMAIL_RETRY_BACKOFF_MINUTES).toEqual(WEBHOOK_RETRY_BACKOFF_MINUTES);
  });

  describe('the jitter window', () => {
    it('spans half a step to a whole one', () => {
      const window = emailRetryWindowMs(1)!;
      const stepMs = EMAIL_RETRY_BACKOFF_MINUTES[0]! * 60_000;
      expect(window.maxMs).toBe(stepMs);
      expect(window.minMs).toBe(stepMs * EMAIL_JITTER_FLOOR);
    });

    it('never shortens a step past its own order of magnitude', () => {
      // Full jitter (uniform in [0, step]) would retry a six-hour step after
      // four minutes, undoing the reasoning behind having steps at all.
      for (let made = 1; made < EMAIL_MAX_ATTEMPTS; made += 1) {
        const window = emailRetryWindowMs(made)!;
        expect(window.minMs).toBeGreaterThanOrEqual(window.maxMs / 2);
      }
    });

    it('has no window once the ladder is spent', () => {
      expect(emailRetryWindowMs(EMAIL_MAX_ATTEMPTS)).toBeNull();
    });
  });
});
