import { describe, expect, it } from 'vitest';
import {
  buildWebhookPayload,
  isPermanentDeliveryFailure,
  isPrivateAddress,
  isPublicWebhookHost,
  isValidWebhookUrl,
  newWebhookSecret,
  nextAttemptAt,
  retryDelayMinutes,
  signWebhookBody,
  verifyWebhookSignature,
  webhookWantsEvent,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_BACKOFF_MINUTES,
  parseRetryAfter,
  MAX_RETRY_AFTER_SECONDS,
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
    expect(isValidWebhookUrl('ftp://example.com/hook')).toBe(false);
    expect(isValidWebhookUrl('file:///etc/passwd')).toBe(false);
    expect(isValidWebhookUrl('not a url')).toBe(false);
  });

  it('refuses a webhook URL pointing back inside the network', () => {
    // The partner picks this URL and this service fetches it. Loopback is the
    // sibling services on 3000–3004; 169.254.169.254 is the cloud metadata
    // endpoint. Both were accepted before the guard.
    expect(isValidWebhookUrl('http://127.0.0.1:8080/hook')).toBe(false);
    expect(isValidWebhookUrl('http://localhost:3001/api/v1/admin')).toBe(false);
    expect(isValidWebhookUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isValidWebhookUrl('http://10.0.0.5/hook')).toBe(false);
    expect(isValidWebhookUrl('http://192.168.1.1/hook')).toBe(false);
    expect(isValidWebhookUrl('http://172.16.0.1/hook')).toBe(false);
    expect(isValidWebhookUrl('http://[::1]:3001/hook')).toBe(false);
    expect(isValidWebhookUrl('http://engine.internal/hook')).toBe(false);
    expect(isValidWebhookUrl('http://receiver.local/hook')).toBe(false);
    // …and the same URL passes where a local development environment has
    // deliberately opted in.
    expect(isValidWebhookUrl('http://127.0.0.1:8080/hook', true)).toBe(true);
  });

  it('classifies non-routable addresses, including the v6 spellings of v4', () => {
    for (const blocked of [
      '0.0.0.0',
      '127.0.0.1',
      '10.255.255.255',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1', // CGNAT
      '198.18.0.1', // benchmarking
      '224.0.0.1', // multicast
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1', // v4-mapped loopback
      '::ffff:10.0.0.1',
      'not-an-address',
    ]) {
      expect(isPrivateAddress(blocked), blocked).toBe(true);
    }
    for (const allowed of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(allowed), allowed).toBe(false);
    }
  });

  it('leaves a hostname to be decided at delivery, when it resolves', () => {
    // A name is public until DNS says otherwise, and DNS is answered at
    // delivery — so registration passes it and the hook re-checks.
    expect(isPublicWebhookHost('hooks.example.com')).toBe(true);
    expect(isPublicWebhookHost('example.com.')).toBe(true); // trailing root dot
    expect(isPublicWebhookHost('LOCALHOST')).toBe(false);
    expect(isPublicWebhookHost('')).toBe(false);
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
  it('backs off 1 / 5 / 30 / 120 / 360 minutes and then gives up', () => {
    expect(WEBHOOK_RETRY_BACKOFF_MINUTES).toEqual([1, 5, 30, 120, 360]);
    // attemptsMade counts the attempt that just failed, as the row reads after
    // a claim, so the first failure asks for the first step.
    expect(retryDelayMinutes(1)).toBe(1);
    expect(retryDelayMinutes(2)).toBe(5);
    expect(retryDelayMinutes(3)).toBe(30);
    expect(retryDelayMinutes(4)).toBe(120);
    expect(retryDelayMinutes(5)).toBe(360);
    expect(retryDelayMinutes(WEBHOOK_MAX_ATTEMPTS)).toBeNull();
  });

  it('reaches far enough to outlast an ordinary incident', () => {
    // The reason the ladder grew. At 36 minutes' reach, every outage longer
    // than half an hour dropped the partner's events permanently while the
    // receiver was merely down.
    const total = WEBHOOK_RETRY_BACKOFF_MINUTES.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(8 * 60);
  });

  it('allows the initial attempt plus one per backoff step', () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(WEBHOOK_RETRY_BACKOFF_MINUTES.length + 1);
  });

  it('honours a raised ceiling by holding at the longest step', () => {
    // A partner endpoint given max_attempts 6 must actually get six tries; if
    // running past the backoff table read as "terminal", raising the ceiling
    // would silently do nothing.
    expect(retryDelayMinutes(6, 8)).toBe(360);
    expect(retryDelayMinutes(7, 8)).toBe(360);
    expect(retryDelayMinutes(8, 8)).toBeNull();
  });

  it('respects a lowered ceiling', () => {
    expect(retryDelayMinutes(1, 2)).toBe(1);
    expect(retryDelayMinutes(2, 2)).toBeNull();
    // max_attempts 1 is the old one-shot behaviour.
    expect(retryDelayMinutes(1, 1)).toBeNull();
  });

  it('schedules the next attempt off the supplied clock', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    // random() = 1 is the top of the jitter range, i.e. the unjittered step.
    const top = { random: () => 1 };
    expect(nextAttemptAt(1, WEBHOOK_MAX_ATTEMPTS, now, top)?.toISOString()).toBe('2026-08-07T12:01:00.000Z');
    expect(nextAttemptAt(2, WEBHOOK_MAX_ATTEMPTS, now, top)?.toISOString()).toBe('2026-08-07T12:05:00.000Z');
    expect(nextAttemptAt(3, WEBHOOK_MAX_ATTEMPTS, now, top)?.toISOString()).toBe('2026-08-07T12:30:00.000Z');
    expect(nextAttemptAt(WEBHOOK_MAX_ATTEMPTS, WEBHOOK_MAX_ATTEMPTS, now, top)).toBeNull();
  });

  it('jitters into the top half of the step, so a backlog does not come due at once', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    // An outage fails every delivery in flight at the same moment. Without
    // jitter they all get the identical next_attempt_at, and the sweep serves
    // the receiver its whole outage the instant it comes back — which is how a
    // receiver that has just restarted goes down a second time.
    const floor = nextAttemptAt(3, WEBHOOK_MAX_ATTEMPTS, now, { random: () => 0 })!;
    const ceiling = nextAttemptAt(3, WEBHOOK_MAX_ATTEMPTS, now, { random: () => 1 })!;
    expect(floor.toISOString()).toBe('2026-08-07T12:15:00.000Z');
    expect(ceiling.toISOString()).toBe('2026-08-07T12:30:00.000Z');

    // Never longer than the step: the ladder's reach is a bound, not an average.
    const spread = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const at = nextAttemptAt(3, WEBHOOK_MAX_ATTEMPTS, now)!.getTime();
      expect(at).toBeGreaterThanOrEqual(floor.getTime());
      expect(at).toBeLessThanOrEqual(ceiling.getTime());
      spread.add(at);
    }
    // The decorrelation is the whole point, so assert it actually spreads
    // rather than merely staying in range.
    expect(spread.size).toBeGreaterThan(50);
  });

  it('waits as long as a rate-limiting receiver asked, instead of the ladder', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    // A 429 carrying Retry-After is the receiver stating when it will be
    // ready. Retrying at the ladder's 1 minute gets rate-limited again and
    // burns an attempt on a request we were told would fail.
    expect(nextAttemptAt(1, WEBHOOK_MAX_ATTEMPTS, now, { retryAfterSeconds: 900 })?.toISOString()).toBe(
      '2026-08-07T12:15:00.000Z',
    );
    // Not jittered: the receiver chose the time.
    expect(
      nextAttemptAt(1, WEBHOOK_MAX_ATTEMPTS, now, { retryAfterSeconds: 900, random: () => 0 })?.toISOString(),
    ).toBe('2026-08-07T12:15:00.000Z');
  });

  it('will not let Retry-After keep an exhausted row in the queue', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    // Otherwise a receiver could answer 429-with-a-header forever and never
    // let its deliveries settle.
    expect(
      nextAttemptAt(WEBHOOK_MAX_ATTEMPTS, WEBHOOK_MAX_ATTEMPTS, now, { retryAfterSeconds: 30 }),
    ).toBeNull();
  });

  it('reads both Retry-After forms and refuses the rest', () => {
    const now = new Date('2026-08-07T12:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter('Fri, 07 Aug 2026 12:02:00 GMT', now)).toBe(120);
    // A date already past means "now", not a negative delay.
    expect(parseRetryAfter('Fri, 07 Aug 2026 11:00:00 GMT', now)).toBe(0);
    // Unusable values fall back to the ladder rather than to a NaN.
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('-30', now)).toBeNull();
    // A remote header does not get to choose how long our row sits in the queue.
    expect(parseRetryAfter(String(30 * 24 * 3600), now)).toBe(MAX_RETRY_AFTER_SECONDS);
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
