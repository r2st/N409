import { describe, expect, it } from 'vitest';
import {
  addonFlags,
  bandForRaise,
  DEFAULT_PRICE_CENTS,
  EXPRESS_DELIVERY_CENTS,
  EXPRESS_DELIVERY_DAYS,
  FALLBACK_PRICE_CENTS,
  priceForKind,
  QSBS_LETTER_CENTS,
  quoteLines,
  quotePrice,
  RAISE_BANDS,
  STANDARD_DELIVERY_DAYS,
} from '../../src/domain/pricing.js';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';

const M = (millions: number) => millions * 1_000_000 * 100;

describe('capital-raised bands', () => {
  it('covers the number line with no gap and no overlap', () => {
    // Each band's bound is the next one's floor, and only the last is open.
    const bounds = RAISE_BANDS.map((b) => b.max_cents);
    expect(bounds.at(-1)).toBeNull();
    expect(bounds.slice(0, -1).every((b) => typeof b === 'number')).toBe(true);
    for (let i = 1; i < bounds.length - 1; i++) {
      expect(bounds[i]!).toBeGreaterThan(bounds[i - 1]!);
    }
  });

  it('places a raise in the first band it falls under', () => {
    expect(bandForRaise(0).key).toBe('under_1m');
    expect(bandForRaise(M(0.999)).key).toBe('under_1m');
    // The bound is exclusive: exactly $1M is the next band up.
    expect(bandForRaise(M(1)).key).toBe('1m_to_5m');
    expect(bandForRaise(M(4.9)).key).toBe('1m_to_5m');
    expect(bandForRaise(M(5)).key).toBe('5m_to_10m');
    expect(bandForRaise(M(10)).key).toBe('10m_to_20m');
    expect(bandForRaise(M(20)).key).toBe('over_20m');
    expect(bandForRaise(M(500)).key).toBe('over_20m');
  });

  it('reads a bigint column arriving as a string', () => {
    // pg hands bigint back as text; Number() on the string must still band.
    expect(bandForRaise('750000000').key).toBe('5m_to_10m');
  });

  it('treats an unknown raise as the entry band, never the top one', () => {
    // Most companies have not told us at the point of payment. Guessing high
    // overcharges a seed company for a fact we failed to collect.
    for (const value of [null, undefined, '', 'not-a-number', NaN, -1, -M(5)]) {
      expect(bandForRaise(value as never).key).toBe('under_1m');
      expect(bandForRaise(value as never).uplift_cents).toBe(0);
    }
  });
});

describe('quotePrice', () => {
  it('charges the entry price on the entry band with no add-ons', () => {
    const q = quotePrice({ kind: '409a', amountRaisedCents: 0 });
    expect(q.amount_cents).toBe(DEFAULT_PRICE_CENTS['409a']);
    expect(q.band_uplift_cents).toBe(0);
    expect(q.addons).toEqual([]);
    expect(q.delivery_days).toBe(STANDARD_DELIVERY_DAYS);
  });

  it('charges the same flat price regardless of capital raised', () => {
    expect(quotePrice({ kind: '409a', amountRaisedCents: M(25) }).amount_cents).toBe(4_900);
  });

  it('walks the whole 409A ladder — flat, no band uplift', () => {
    const ladder = [M(0.5), M(2), M(7), M(15), M(40)].map(
      (raised) => quotePrice({ kind: '409a', amountRaisedCents: raised }).amount_cents,
    );
    expect(ladder).toEqual([4_900, 4_900, 4_900, 4_900, 4_900]);
  });

  it('applies one uplift ladder to every product kind', () => {
    // The increment is a property of the company, not of the deliverable, so
    // the gap between bands is identical across kinds.
    for (const kind of VALUATION_KINDS) {
      const entry = quotePrice({ kind, amountRaisedCents: 0 }).amount_cents;
      const top = quotePrice({ kind, amountRaisedCents: M(50) }).amount_cents;
      expect(entry).toBe(priceForKind(kind));
      expect(top - entry).toBe(RAISE_BANDS.at(-1)!.uplift_cents);
    }
  });

  it('prices an unknown kind at the fallback', () => {
    expect(quotePrice({ kind: 'not-a-product', amountRaisedCents: 0 }).amount_cents).toBe(
      FALLBACK_PRICE_CENTS,
    );
  });

  it('adds express delivery and moves the SLA to one business day', () => {
    const q = quotePrice({ kind: '409a', amountRaisedCents: 0, addons: { express: true } });
    expect(q.amount_cents).toBe(DEFAULT_PRICE_CENTS['409a']! + EXPRESS_DELIVERY_CENTS);
    expect(q.delivery_days).toBe(EXPRESS_DELIVERY_DAYS);
    expect(addonFlags(q)).toEqual({ express: true, qsbs_letter: false });
  });

  it('stacks the base and both add-ons (band uplift is zero)', () => {
    const q = quotePrice({
      kind: '409a',
      amountRaisedCents: M(12),
      addons: { express: true, qsbs_letter: true },
    });
    expect(q.amount_cents).toBe(
      DEFAULT_PRICE_CENTS['409a']! + EXPRESS_DELIVERY_CENTS + QSBS_LETTER_CENTS,
    );
    expect(addonFlags(q)).toEqual({ express: true, qsbs_letter: true });
  });

  it('refuses the QSBS letter on a QSBS engagement instead of charging for it', () => {
    // The attestation IS the deliverable. Billing $500 for a document already
    // inside the report is the error a client finds after they have paid.
    const q = quotePrice({ kind: 'qsbs', amountRaisedCents: 0, addons: { qsbs_letter: true } });
    expect(q.amount_cents).toBe(priceForKind('qsbs'));
    expect(q.addons).toEqual([]);
    expect(q.unavailable_addons).toEqual([
      { key: 'qsbs_letter', reason: 'A QSBS engagement already includes the attestation letter.' },
    ]);
  });

  it('still sells express on a QSBS engagement', () => {
    const q = quotePrice({
      kind: 'qsbs',
      amountRaisedCents: 0,
      addons: { express: true, qsbs_letter: true },
    });
    expect(q.addons.map((a) => a.key)).toEqual(['express']);
    expect(q.unavailable_addons).toHaveLength(1);
  });
});

describe('quoteLines', () => {
  it('itemises entry price and add-ons, and sums to the total', () => {
    const q = quotePrice({
      kind: '409a',
      amountRaisedCents: M(30),
      addons: { express: true, qsbs_letter: true },
    });
    const lines = quoteLines(q);
    expect(lines.map((l) => l.key)).toEqual(['base', 'express', 'qsbs_letter']);
    expect(lines.reduce((sum, l) => sum + l.amount_cents, 0)).toBe(q.amount_cents);
  });

  it('omits a zero band line rather than printing "$0"', () => {
    const lines = quoteLines(quotePrice({ kind: 'fmv', amountRaisedCents: 0 }));
    expect(lines.map((l) => l.key)).toEqual(['base']);
  });

  it('sums to the total for every band and add-on combination', () => {
    for (const band of RAISE_BANDS) {
      const raised = band.max_cents === null ? M(100) : band.max_cents - 1;
      for (const express of [false, true]) {
        for (const qsbs_letter of [false, true]) {
          const q = quotePrice({
            kind: '409a',
            amountRaisedCents: raised,
            addons: { express, qsbs_letter },
          });
          expect(quoteLines(q).reduce((s, l) => s + l.amount_cents, 0)).toBe(q.amount_cents);
        }
      }
    }
  });
});
