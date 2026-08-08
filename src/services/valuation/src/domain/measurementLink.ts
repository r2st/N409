/**
 * Raised when an engagement already has a measurement subject — the unique
 * indexes migration 0109 puts on `fund_portfolios.valuation_id` and
 * `debt_instruments.valuation_id`.
 *
 * Its own type, and its own module, for two reasons. The routes answer it with
 * a 409 and a message an analyst can act on, rather than the 500 a raw unique
 * violation becomes; and both measurement repos throw it, so it cannot live in
 * either without making the other import it sideways.
 */
export class MeasurementLinkConflict extends Error {}
