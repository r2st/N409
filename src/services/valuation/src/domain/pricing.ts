/**
 * What a one-off engagement costs: base price by product, a band uplift by
 * capital raised, and the two optional add-ons.
 *
 * Pure, and deliberately the single source of the number. Before this module
 * the checkout charged a flat `DEFAULT_PRICE_CENTS[kind]` while the public
 * pricing calculator quoted express and QSBS add-ons the checkout could not
 * sell — a client could configure a $1,690 order on /pricing and be charged
 * $1,190 at the Stripe page, or the reverse once they expected next-day
 * delivery. Both surfaces now read this file.
 *
 * Money never leaves here as a bare integer without the breakdown that
 * produced it: `quotePrice` returns the base, the band and each add-on as
 * separate lines because that is what a client disputing an invoice asks for,
 * and what the invoice PDF has to itemise.
 */

import type { ValuationKind } from './valuation.js';

/**
 * Entry price per product kind, cents — what the lowest raise band pays.
 *
 * These are the platform's published figures: migration 0100 reconciled them
 * against `plan_limits`, the marketing site quotes them, and
 * test/integration/planPricing.test.ts asserts the three agree. 409.ai's own
 * ladder starts lower ($899); ours starts at the price this deployment has
 * always charged, and repricing the flagship product downward is a commercial
 * decision rather than an engineering one. Change these and the plan seed and
 * marketing copy have to move with them — the test names the row.
 */
export const DEFAULT_PRICE_CENTS: Partial<Record<ValuationKind, number>> = {
  '409a': 119_000,
  fmv: 99_000,
  '718': 149_000,
  '820': 149_000,
};

export const FALLBACK_PRICE_CENTS = 99_000;

/** Entry price for a kind, before any band uplift or add-on. */
export function priceForKind(kind: string): number {
  return DEFAULT_PRICE_CENTS[kind as ValuationKind] ?? FALLBACK_PRICE_CENTS;
}

// ── Capital-raised bands ─────────────────────────────────────────────────────

export interface RaiseBand {
  key: string;
  label: string;
  /**
   * Exclusive upper bound in cents; `null` on the top band, which has none.
   * A valuation is in the first band whose bound it falls under.
   */
  max_cents: number | null;
  /** Added to the kind's entry price, cents. */
  uplift_cents: number;
}

const M = (millions: number) => Math.round(millions * 1_000_000 * 100);

/**
 * The five bands 409.ai's pricing slider draws, priced as an uplift rather
 * than as an absolute per-kind ladder.
 *
 * One ladder for every product is the point: a company that raised $30M is a
 * harder engagement by the same margin whether the deliverable is a 409A or an
 * ASC 820 portfolio mark — more securities, more rounds, more diligence — so
 * the increment is a property of the company, not of the report. Expressing it
 * as an uplift also means a new product kind is priced correctly the day it is
 * added, with one entry in DEFAULT_PRICE_CENTS and nothing here.
 *
 * The top uplift is 230_900 and not a round number on purpose: it puts the
 * flagship 409A at exactly $3,499 (119_000 + 230_900), the published ceiling.
 */
export const RAISE_BANDS: readonly RaiseBand[] = [
  { key: 'under_1m', label: 'Under $1M raised', max_cents: M(1), uplift_cents: 0 },
  { key: '1m_to_5m', label: '$1M – $5M raised', max_cents: M(5), uplift_cents: 50_000 },
  { key: '5m_to_10m', label: '$5M – $10M raised', max_cents: M(10), uplift_cents: 110_000 },
  { key: '10m_to_20m', label: '$10M – $20M raised', max_cents: M(20), uplift_cents: 170_000 },
  { key: 'over_20m', label: '$20M+ raised', max_cents: null, uplift_cents: 230_900 },
];

/**
 * The band a raise total falls in.
 *
 * An unknown raise (null — the company never told us, which is most of them at
 * the point of payment) is the *entry* band, not the top one. Guessing high
 * would overcharge a seed company for a fact we failed to collect; guessing
 * low undercharges a late-stage one who can be re-quoted once the cap table
 * lands. The asymmetry is deliberate and is the reason this is not a lookup.
 *
 * Negative and non-finite values are treated the same way as absent.
 */
export function bandForRaise(amountRaisedCents: number | string | null | undefined): RaiseBand {
  const entry = RAISE_BANDS[0]!;
  if (amountRaisedCents === null || amountRaisedCents === undefined) return entry;
  const n = Number(amountRaisedCents);
  if (!Number.isFinite(n) || n < 0) return entry;
  return RAISE_BANDS.find((b) => b.max_cents === null || n < b.max_cents) ?? entry;
}

// ── Add-ons ──────────────────────────────────────────────────────────────────

export const ADDON_KEYS = ['express', 'qsbs_letter'] as const;
export type AddonKey = (typeof ADDON_KEYS)[number];

export const EXPRESS_DELIVERY_CENTS = 50_000;
export const QSBS_LETTER_CENTS = 50_000;

/** Business days to the final report. */
export const STANDARD_DELIVERY_DAYS = 7;
export const EXPRESS_DELIVERY_DAYS = 1;

export interface AddonSelection {
  express?: boolean;
  qsbs_letter?: boolean;
}

export interface QuoteLine {
  key: string;
  label: string;
  amount_cents: number;
}

export interface PriceQuote {
  kind: string;
  /** Entry price for the kind. */
  base_cents: number;
  band: RaiseBand;
  /** What the band added. Zero on the entry band. */
  band_uplift_cents: number;
  /** The add-ons actually sold — a suppressed one does not appear. */
  addons: QuoteLine[];
  /** base + band + add-ons. What Stripe is asked to charge. */
  amount_cents: number;
  delivery_days: number;
  /** Add-ons asked for and refused, with the reason. Shown, not silently dropped. */
  unavailable_addons: Array<{ key: AddonKey; reason: string }>;
}

/**
 * Price one engagement.
 *
 * The QSBS letter is refused on a QSBS engagement rather than charged: the
 * attestation *is* that deliverable, and billing $500 for a document already
 * inside the report is the kind of error a client finds after they have paid.
 * Refusals are returned rather than dropped so the UI can say why the checkbox
 * it offered did not appear on the total.
 */
export function quotePrice(args: {
  kind: string;
  amountRaisedCents?: number | string | null;
  addons?: AddonSelection;
}): PriceQuote {
  const base = priceForKind(args.kind);
  const band = bandForRaise(args.amountRaisedCents);
  const addons: QuoteLine[] = [];
  const unavailable: Array<{ key: AddonKey; reason: string }> = [];

  if (args.addons?.express) {
    addons.push({
      key: 'express',
      label: `Express delivery — ${EXPRESS_DELIVERY_DAYS} business day`,
      amount_cents: EXPRESS_DELIVERY_CENTS,
    });
  }
  if (args.addons?.qsbs_letter) {
    if (args.kind === 'qsbs') {
      unavailable.push({
        key: 'qsbs_letter',
        reason: 'A QSBS engagement already includes the attestation letter.',
      });
    } else {
      addons.push({
        key: 'qsbs_letter',
        label: 'QSBS attestation letter',
        amount_cents: QSBS_LETTER_CENTS,
      });
    }
  }

  const addonTotal = addons.reduce((sum, a) => sum + a.amount_cents, 0);
  return {
    kind: args.kind,
    base_cents: base,
    band,
    band_uplift_cents: band.uplift_cents,
    addons,
    amount_cents: base + band.uplift_cents + addonTotal,
    delivery_days: args.addons?.express ? EXPRESS_DELIVERY_DAYS : STANDARD_DELIVERY_DAYS,
    unavailable_addons: unavailable,
  };
}

/**
 * The quote's lines as an itemised list, entry price first.
 *
 * The invoice and the Stripe line-item description both need the breakdown in
 * one order, and reconstructing it at each call site is how the two drift.
 */
export function quoteLines(quote: PriceQuote): QuoteLine[] {
  return [
    { key: 'base', label: `${quote.kind.toUpperCase()} valuation`, amount_cents: quote.base_cents },
    ...(quote.band_uplift_cents > 0
      ? [{ key: 'band', label: quote.band.label, amount_cents: quote.band_uplift_cents }]
      : []),
    ...quote.addons,
  ];
}

/** The add-ons on a quote, as the flags persisted with the payment row. */
export function addonFlags(quote: PriceQuote): Record<AddonKey, boolean> {
  const sold = new Set(quote.addons.map((a) => a.key));
  return { express: sold.has('express'), qsbs_letter: sold.has('qsbs_letter') };
}
