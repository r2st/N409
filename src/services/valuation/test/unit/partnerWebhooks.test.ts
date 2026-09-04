import { describe, expect, it } from 'vitest';
import {
  buildWebhookPayload,
  isPermanentDeliveryFailure,
  isPrivateAddress,
  isPublicWebhookHost,
  isValidWebhookUrl,
  webhookUrlRefusal,
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
  deliveryLeaseMs,
  DELIVERY_ATTEMPT_BUDGET_MS,
  DELIVERY_LEASE_FLOOR_MS,
} from '../../src/domain/partnerWebhooks.js';
import { DELIVERY_CLAIM_BATCH_DEFAULT, DELIVERY_CLAIM_BATCH_MAX } from '../../src/repos/partnerWebhooks.js';

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

  /**
   * The refusal names the cause the reader can act on.
   *
   * Every one of these was the same sentence about loopback and link-local
   * addresses, including the two failures that have nothing to do with an
   * address — which is the shape that sends a partner to check their egress
   * rules over a missing `https://`.
   */
  describe('the reason a webhook URL was refused', () => {
    it('says nothing at all when the URL is fine', () => {
      expect(webhookUrlRefusal('https://example.com/hook')).toBeNull();
      expect(webhookUrlRefusal('http://127.0.0.1:8080/hook', true)).toBeNull();
    });

    it('names the missing scheme, and does not mention private addresses', () => {
      const refusal = webhookUrlRefusal('api.example.com/hooks/n409');
      expect(refusal).toMatch(/scheme/i);
      expect(refusal).toContain('https://');
      expect(refusal).not.toMatch(/loopback|private|link-local/i);
    });

    it('separates an unparseable URL that does carry a scheme', () => {
      const refusal = webhookUrlRefusal('https://');
      expect(refusal).toMatch(/could not be parsed/i);
      expect(refusal).not.toMatch(/loopback|private|link-local/i);
    });

    it('names the scheme it will not deliver over', () => {
      expect(webhookUrlRefusal('ftp://example.com/hook')).toContain('ftp');
      expect(webhookUrlRefusal('file:///etc/passwd')).toContain('file');
      expect(webhookUrlRefusal('ftp://example.com/hook')).not.toMatch(/loopback/i);
    });

    it('names the host it will not reach, for the case that really is one', () => {
      expect(webhookUrlRefusal('http://127.0.0.1:8080/hook')).toContain('127.0.0.1');
      expect(webhookUrlRefusal('http://engine.internal/hook')).toContain('engine.internal');
      expect(webhookUrlRefusal('http://localhost:3001/api/v1/admin')).toMatch(/loopback/i);
    });

    /*
     * The host reaches an RFC 9457 `detail` that the SPA draws and a partner's
     * own log keeps, and it arrives from a request body. The parser turns away
     * the reordering controls — `new URL('http://10.0.0.5\u202e/')` throws, so
     * that case never reaches the sentence — but it has no opinion at all about
     * length: a 309-character host parses, and `url` is bounded at 2000. So the
     * bound is the half worth asserting, and `quoteForMessage` is what applies
     * it.
     */
    it('bounds the host it quotes back', () => {
      const long = `${'a'.repeat(300)}.internal`;
      expect(new URL(`http://${long}/hook`).hostname).toHaveLength(long.length);
      const refusal = webhookUrlRefusal(`http://${long}/hook`);
      expect(refusal).not.toContain(long);
      expect(refusal).toContain('…');
      expect(refusal!.length).toBeLessThan(400);
    });
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

/**
 * The one invariant that ties the claim to the sweep that works through it.
 *
 * `retryDueDeliveries` claims a batch and then POSTs the rows in it one after
 * another, so the lease is not covering an attempt — it is covering all of them.
 * Whenever `lease < batch x attempt`, the tail of every batch sits in a row
 * whose lease has lapsed while a live sweeper is still going to deliver it, and
 * a second sweeper (the ops retry route, or a second instance) re-claims and
 * re-POSTs it: the partner's receiver gets the event twice.
 *
 * The old lease was a flat five minutes against a hundred-row batch, which
 * covered the first twenty rows of it.
 */
describe('a claim is leased for as long as the batch takes to work through', () => {
  it('covers the default batch', () => {
    expect(deliveryLeaseMs(DELIVERY_CLAIM_BATCH_DEFAULT)).toBeGreaterThanOrEqual(
      DELIVERY_CLAIM_BATCH_DEFAULT * DELIVERY_ATTEMPT_BUDGET_MS,
    );
  });

  it('covers the largest batch a caller may ask for', () => {
    expect(deliveryLeaseMs(DELIVERY_CLAIM_BATCH_MAX)).toBeGreaterThanOrEqual(
      DELIVERY_CLAIM_BATCH_MAX * DELIVERY_ATTEMPT_BUDGET_MS,
    );
  });

  it('holds for every batch size, not just the two the callers use', () => {
    for (const limit of [1, 2, 7, 19, 20, 21, 50, 99, 100, 250, 500]) {
      expect(deliveryLeaseMs(limit)).toBeGreaterThanOrEqual(limit * DELIVERY_ATTEMPT_BUDGET_MS);
    }
  });

  it('never drops below the floor for a small batch', () => {
    // A one-row batch still gets the floor: the lease is also the grace period
    // the reaper reads as "nobody is holding this row", and fifteen seconds of
    // that would reap deliveries that are merely slow.
    expect(deliveryLeaseMs(1)).toBe(DELIVERY_LEASE_FLOOR_MS);
    expect(deliveryLeaseMs(0)).toBe(DELIVERY_LEASE_FLOOR_MS);
  });

  it('budgets more than the POST timeout, because an attempt is not only the POST', () => {
    // The SSRF guard resolves the target before the request and the settle
    // writes after it, and `AbortSignal.timeout` bounds neither.
    expect(DELIVERY_ATTEMPT_BUDGET_MS).toBeGreaterThan(10_000);
  });
});
