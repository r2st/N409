import { describe, expect, it } from 'vitest';
import {
  buildWebhookPayload,
  isPermanentDeliveryFailure,
  isValidWebhookUrl,
  newWebhookSecret,
  nextAttemptAt,
  retryDelayMinutes,
  signWebhookBody,
  verifyWebhookSignature,
  webhookWantsEvent,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_BACKOFF_MINUTES,
} from '../../src/domain/partnerWebhooks.js';

describe('partner webhook domain', () => {
  it('signs and verifies over exact body bytes', () => {
    const secret = newWebhookSecret();
    const body = JSON.stringify({ event: 'webhook.test', n: 1 });
    const signature = signWebhookBody(secret, body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, body + ' ', signature)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha256=' + '0'.repeat(64))).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'nonsense')).toBe(false);
  });

  it('mints distinct prefixed secrets', () => {
    const a = newWebhookSecret();
    const b = newWebhookSecret();
    expect(a).toMatch(/^n409_whsec_/);
    expect(a).not.toBe(b);
  });

  it('treats an empty subscription list as every event', () => {
    expect(webhookWantsEvent([], 'valuation.state_changed')).toBe(true);
    expect(webhookWantsEvent(['valuation.report_ready'], 'valuation.state_changed')).toBe(false);
    expect(webhookWantsEvent(['valuation.report_ready'], 'valuation.report_ready')).toBe(true);
  });

  it('accepts only http(s) webhook URLs', () => {
    expect(isValidWebhookUrl('https://example.com/hook')).toBe(true);
    expect(isValidWebhookUrl('http://127.0.0.1:8080/hook')).toBe(true);
    expect(isValidWebhookUrl('ftp://example.com/hook')).toBe(false);
    expect(isValidWebhookUrl('file:///etc/passwd')).toBe(false);
    expect(isValidWebhookUrl('not a url')).toBe(false);
  });

  it('stamps payloads with the event and send time', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    const payload = buildWebhookPayload(
      'valuation.state_changed',
      { id: '01J', number: 42, kind: 'qsbs', state: 'started', company_name: 'Acme' },
      { previous_state: 'pending' },
      now,
    );
    expect(payload.created_at).toBe('2026-08-07T12:00:00.000Z');
    expect(payload.valuation?.kind).toBe('qsbs');
    expect(payload.previous_state).toBe('pending');
  });
});

describe('webhook delivery retries', () => {
  it('backs off 1 / 5 / 30 minutes and then gives up', () => {
    expect(WEBHOOK_RETRY_BACKOFF_MINUTES).toEqual([1, 5, 30]);
    // attemptsMade counts the attempt that just failed, as the row reads after
    // a claim, so the first failure asks for the first step.
    expect(retryDelayMinutes(1)).toBe(1);
    expect(retryDelayMinutes(2)).toBe(5);
    expect(retryDelayMinutes(3)).toBe(30);
    expect(retryDelayMinutes(WEBHOOK_MAX_ATTEMPTS)).toBeNull();
  });

  it('allows the initial attempt plus one per backoff step', () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(WEBHOOK_RETRY_BACKOFF_MINUTES.length + 1);
  });

  it('honours a raised ceiling by holding at the longest step', () => {
    // A partner endpoint given max_attempts 6 must actually get six tries; if
    // running past the backoff table read as "terminal", raising the ceiling
    // would silently do nothing.
    expect(retryDelayMinutes(4, 6)).toBe(30);
    expect(retryDelayMinutes(5, 6)).toBe(30);
    expect(retryDelayMinutes(6, 6)).toBeNull();
  });

  it('respects a lowered ceiling', () => {
    expect(retryDelayMinutes(1, 2)).toBe(1);
    expect(retryDelayMinutes(2, 2)).toBeNull();
    // max_attempts 1 is the old one-shot behaviour.
    expect(retryDelayMinutes(1, 1)).toBeNull();
  });

  it('schedules the next attempt off the supplied clock', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    expect(nextAttemptAt(1, WEBHOOK_MAX_ATTEMPTS, now)?.toISOString()).toBe('2026-08-07T12:01:00.000Z');
    expect(nextAttemptAt(2, WEBHOOK_MAX_ATTEMPTS, now)?.toISOString()).toBe('2026-08-07T12:05:00.000Z');
    expect(nextAttemptAt(3, WEBHOOK_MAX_ATTEMPTS, now)?.toISOString()).toBe('2026-08-07T12:30:00.000Z');
    expect(nextAttemptAt(4, WEBHOOK_MAX_ATTEMPTS, now)).toBeNull();
  });

  it('does not retry a response the receiver told us not to repeat', () => {
    // The request itself is the problem — three more identical POSTs change
    // nothing and delay the partner learning their endpoint is wrong.
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(isPermanentDeliveryFailure(status)).toBe(true);
    }
  });

  it('retries the transient classes', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isPermanentDeliveryFailure(status)).toBe(false);
    }
  });
});
