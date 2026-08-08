/**
 * The four valuation approaches, and the three names each one has.
 *
 * The UI says `opm`, the engine's results say `opm_backsolve`, and the params
 * row says `weight_opm`. That is not accidental — each vocabulary belongs to
 * its own layer — but it means anything reasoning about "which approaches does
 * this engagement run" needs all three, and a second copy of the mapping is a
 * second answer to that question.
 *
 * It lives in `domain/` rather than beside the recalculate route because the
 * header counters (§7.3) read it too, and a domain module importing a route to
 * find out what an approach is called is the wrong direction.
 */

export const RECALC_APPROACHES = {
  asset: { engineKey: 'asset', weightKey: 'weight_asset' },
  opm: { engineKey: 'opm_backsolve', weightKey: 'weight_opm' },
  income: { engineKey: 'income', weightKey: 'weight_income' },
  market: { engineKey: 'market', weightKey: 'weight_market' },
} as const;

export type RecalcApproach = keyof typeof RECALC_APPROACHES;

export const RECALC_APPROACH_KEYS = Object.keys(RECALC_APPROACHES) as RecalcApproach[];
