import { describe, expect, it } from 'vitest';
import {
  classifyDsnStatus,
  classifySmtpReply,
  deliveryStateOf,
  isTerminalBounce,
  rateOrNull,
  RATE_FLOOR,
  type DeliveryColumns,
} from '../../src/domain/emailDelivery.js';

/**
 * The classifier decides whether an address stops receiving mail. Both wrong
 * answers are expensive, so both are asserted here rather than only the happy
 * "550 means dead" case that motivated the feature.
 */
describe('classifySmtpReply', () => {
  it('treats a permanent rejection of the recipient as a hard bounce', () => {
    expect(classifySmtpReply('rcpt', 550)).toBe('hard');
    expect(classifySmtpReply('rcpt', 553)).toBe('hard');
  });

  it('treats a transient rejection of the recipient as soft, so the ladder keeps it', () => {
    expect(classifySmtpReply('rcpt', 450)).toBe('soft');
    expect(classifySmtpReply('rcpt', 421)).toBe('soft');
  });

  /**
   * The rule the whole subsystem turns on. A relay whose credentials we have
   * wrong answers 535 to every message we send; blaming the recipient would
   * suppress whichever clients happened to be in the outbox during the outage,
   * and they would then stop receiving their reports with nothing in the
   * product saying why.
   */
  it('never blames the recipient for a permanent failure of ours', () => {
    expect(classifySmtpReply('auth', 535)).toBe('soft');
    expect(classifySmtpReply('from', 550)).toBe('soft');
    expect(classifySmtpReply('data', 552)).toBe('soft');
    expect(classifySmtpReply('body', 554)).toBe('soft');
  });

  it('has no opinion on a success or an unparseable reply', () => {
    expect(classifySmtpReply('rcpt', 250)).toBeNull();
    expect(classifySmtpReply('rcpt', null)).toBeNull();
    expect(classifySmtpReply('rcpt', Number.NaN)).toBeNull();
  });
});

describe('classifyDsnStatus', () => {
  it('reads the class digit: 5 permanent, 4 transient', () => {
    expect(classifyDsnStatus('5.1.1')).toBe('hard');
    expect(classifyDsnStatus('5.1.10')).toBe('hard');
    expect(classifyDsnStatus('4.4.1')).toBe('soft');
  });

  /**
   * Mailbox-full is reported as 5.2.2 by relays that consider a quota a
   * permanent property of the account. It is not — the owner deletes some mail
   * and it is a working address again — and suppressing on it is the false
   * positive most likely to hit a real client.
   */
  it('forces mailbox-full soft whichever class the relay stamps on it', () => {
    expect(classifyDsnStatus('5.2.2')).toBe('soft');
    expect(classifyDsnStatus('4.2.2')).toBe('soft');
  });

  it('reports nothing for a success code or a malformed status', () => {
    expect(classifyDsnStatus('2.0.0')).toBeNull();
    expect(classifyDsnStatus('nonsense')).toBeNull();
    expect(classifyDsnStatus('6.1.1')).toBeNull();
    expect(classifyDsnStatus('')).toBeNull();
  });
});

describe('isTerminalBounce', () => {
  it('stops on a hard bounce and on a complaint, but not on a soft one', () => {
    expect(isTerminalBounce('hard')).toBe(true);
    expect(isTerminalBounce('complaint')).toBe(true);
    expect(isTerminalBounce('soft')).toBe(false);
  });
});

describe('deliveryStateOf', () => {
  const base: DeliveryColumns = {
    status: 'sent',
    delivered_at: null,
    bounced_at: null,
    first_opened_at: null,
    bounce_kind: null,
  };
  const t = new Date('2026-08-15T10:00:00Z');

  it('keeps sent distinct from delivered', () => {
    expect(deliveryStateOf(base)).toBe('sent');
    expect(deliveryStateOf({ ...base, delivered_at: t })).toBe('delivered');
  });

  it('reports an open over a delivery', () => {
    expect(deliveryStateOf({ ...base, delivered_at: t, first_opened_at: t })).toBe('opened');
  });

  /**
   * A complaint arrives after a successful delivery and often after an open.
   * It has to win, because it is the only one of the three an operator must do
   * something about.
   */
  it('reports a complaint over a delivery and an open', () => {
    expect(
      deliveryStateOf({
        ...base,
        delivered_at: t,
        first_opened_at: t,
        bounced_at: t,
        bounce_kind: 'complaint',
      }),
    ).toBe('complained');
  });

  it('reports a bounce that followed a delivery', () => {
    expect(deliveryStateOf({ ...base, delivered_at: t, bounced_at: t, bounce_kind: 'hard' })).toBe(
      'bounced',
    );
  });

  it('falls through to the send state when nothing downstream has spoken', () => {
    expect(deliveryStateOf({ ...base, status: 'queued' })).toBe('queued');
    expect(deliveryStateOf({ ...base, status: 'failed' })).toBe('failed');
    expect(deliveryStateOf({ ...base, status: 'skipped' })).toBe('skipped');
  });
});

describe('rateOrNull', () => {
  it('refuses to print a rate off a denominator too small to mean anything', () => {
    expect(rateOrNull(0, RATE_FLOOR - 1)).toBeNull();
    expect(rateOrNull(1, 2)).toBeNull();
  });

  it('rounds to two decimals at and above the floor', () => {
    expect(rateOrNull(RATE_FLOOR, RATE_FLOOR)).toBe(100);
    expect(rateOrNull(1, 3 * RATE_FLOOR)).toBe(1.67);
  });
});
