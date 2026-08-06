import { describe, it, expect } from 'vitest';
import {
  collectedTotals,
  disputeRevokesPayment,
  disputeStatusOf,
  refundState,
  type MoneyRow,
} from '../../src/domain/payments.js';

/**
 * Money going back out. These are the decisions that un-bill a client, so the
 * cases that matter are the ones where guessing wrong either leaves a refunded
 * engagement looking paid or pulls a report away from someone who still owns it.
 */

describe('refundState', () => {
  const AMOUNT = 119_000;

  it('a full refund revokes', () => {
    const s = refundState({ amountCents: AMOUNT, amountRefunded: AMOUNT });
    expect(s).toEqual({
      refundedCents: AMOUNT,
      remainingCents: 0,
      fullyRefunded: true,
      partiallyRefunded: false,
    });
  });

  it('a partial refund is recorded but does not revoke', () => {
    const s = refundState({ amountCents: AMOUNT, amountRefunded: 20_000 });
    expect(s.refundedCents).toBe(20_000);
    expect(s.remainingCents).toBe(99_000);
    expect(s.fullyRefunded).toBe(false);
    expect(s.partiallyRefunded).toBe(true);
  });

  it('is idempotent: the same running total recomputes the same state', () => {
    const a = refundState({ amountCents: AMOUNT, amountRefunded: 20_000 });
    const b = refundState({ amountCents: AMOUNT, amountRefunded: 20_000 });
    expect(b).toEqual(a);
  });

  it('accumulates as Stripe reports a growing total, not a delta', () => {
    // Two partial refunds: Stripe's second event carries 20k + 99k, not 99k.
    expect(refundState({ amountCents: AMOUNT, amountRefunded: 119_000 }).fullyRefunded).toBe(true);
  });

  it('treats an over-refund as a full refund rather than negative remainder', () => {
    const s = refundState({ amountCents: AMOUNT, amountRefunded: AMOUNT + 5_000 });
    expect(s.refundedCents).toBe(AMOUNT);
    expect(s.remainingCents).toBe(0);
    expect(s.fullyRefunded).toBe(true);
  });

  it('ignores a missing, non-numeric or negative amount instead of revoking', () => {
    for (const bad of [undefined, null, 'lots', NaN, Infinity, -1]) {
      const s = refundState({ amountCents: AMOUNT, amountRefunded: bad });
      expect(s.refundedCents).toBe(0);
      expect(s.fullyRefunded).toBe(false);
    }
  });

  it('a zero-amount charge is never "fully refunded"', () => {
    // Guards the `remaining === 0` test from calling an empty charge revoked.
    expect(refundState({ amountCents: 0, amountRefunded: 0 }).fullyRefunded).toBe(false);
  });

  it('truncates fractional cents rather than writing them to a bigint column', () => {
    expect(refundState({ amountCents: AMOUNT, amountRefunded: 1_234.9 }).refundedCents).toBe(1_234);
  });
});

describe('disputeStatusOf', () => {
  it('maps the terminal outcomes', () => {
    expect(disputeStatusOf('lost')).toBe('lost');
    expect(disputeStatusOf('won')).toBe('won');
  });

  it('treats a closed early warning as won — no money was ever taken', () => {
    expect(disputeStatusOf('warning_closed')).toBe('won');
  });

  it('treats everything still running as open', () => {
    for (const s of ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review']) {
      expect(disputeStatusOf(s)).toBe('open');
    }
  });

  it('defaults an unknown status to open, never to won', () => {
    // Closing a live case because Stripe added a status we do not know is the
    // failure that silently misses an evidence deadline.
    for (const s of [undefined, null, '', 'brand_new_status', 42]) {
      expect(disputeStatusOf(s)).toBe('open');
    }
  });

  it('only a lost dispute revokes', () => {
    expect(disputeRevokesPayment('lost')).toBe(true);
    expect(disputeRevokesPayment('open')).toBe(false);
    expect(disputeRevokesPayment('won')).toBe(false);
  });
});

describe('collectedTotals', () => {
  const row = (o: Partial<MoneyRow> & { status: string; amount_cents: number }): MoneyRow => ({
    refunded_cents: 0,
    ...o,
  });

  it('sums only settled money', () => {
    const t = collectedTotals([
      row({ status: 'succeeded', amount_cents: 119_000 }),
      row({ status: 'pending', amount_cents: 99_000 }),
      row({ status: 'failed', amount_cents: 99_000 }),
      row({ status: 'expired', amount_cents: 99_000 }),
    ]);
    expect(t.paid_cents).toBe(119_000);
    expect(t.succeeded_count).toBe(1);
    expect(t.payment_count).toBe(4);
  });

  it('nets a full refund out of paid_cents', () => {
    const t = collectedTotals([
      row({ status: 'succeeded', amount_cents: 119_000 }),
      row({ status: 'refunded', amount_cents: 119_000, refunded_cents: 119_000 }),
    ]);
    expect(t.gross_cents).toBe(238_000);
    expect(t.refunded_cents).toBe(119_000);
    expect(t.paid_cents).toBe(119_000);
    expect(t.refunded_count).toBe(1);
    expect(t.succeeded_count).toBe(1);
  });

  it('nets a partial refund out while the row is still succeeded', () => {
    const t = collectedTotals([row({ status: 'succeeded', amount_cents: 119_000, refunded_cents: 20_000 })]);
    expect(t.paid_cents).toBe(99_000);
    expect(t.refunded_cents).toBe(20_000);
    expect(t.succeeded_count).toBe(1);
  });

  it('treats a refunded row with no recorded amount as fully returned', () => {
    // A lost dispute recorded before refunded_cents existed, or any row where
    // the amount failed to land — the status is the stronger statement.
    const t = collectedTotals([row({ status: 'refunded', amount_cents: 119_000, refunded_cents: 0 })]);
    expect(t.refunded_cents).toBe(119_000);
    expect(t.paid_cents).toBe(0);
  });

  it('never reports negative revenue', () => {
    const t = collectedTotals([row({ status: 'succeeded', amount_cents: 100, refunded_cents: 999_999 })]);
    expect(t.paid_cents).toBe(0);
  });

  it('reads bigint columns arriving as strings', () => {
    // pg returns bigint as a string; summing those with + would concatenate.
    const t = collectedTotals([
      { status: 'succeeded', amount_cents: '119000', refunded_cents: '19000' },
      { status: 'succeeded', amount_cents: '99000', refunded_cents: null },
    ]);
    expect(t.paid_cents).toBe(199_000);
  });

  it('is empty-safe', () => {
    expect(collectedTotals([])).toEqual({
      gross_cents: 0,
      refunded_cents: 0,
      paid_cents: 0,
      succeeded_count: 0,
      refunded_count: 0,
      payment_count: 0,
    });
  });
});
