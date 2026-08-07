/**
 * "Every valuation of the same client as this one" — the filter behind the
 * report's FMV trend chart and the analytics time series.
 *
 * Both surfaces answer the same question and each spelled it out in its own
 * SQL, and both spelled it `v.user_id = … AND company_name = …`. That is the
 * wrong equivalence class for a firm's engagement, and the product's own client
 * identity says so: `repos/firmDashboard.firmClients` groups the roster by
 * `(partner_id, company_name)` — one row per company the *firm* has worked for
 * — because there is no clients table and the firm, not a seat inside it, is
 * who the engagement belongs to.
 *
 * So a firm where last year's 409A was run by one member and this year's by
 * another has two rows the console shows as one client and the trend chart sees
 * as two strangers: the chart needs two points and finds one, so it is dropped
 * entirely and the deliverable silently omits the comparison a board asks for
 * first. Client intake makes this the normal case rather than the unlucky one —
 * a converted intake is owned by whoever pressed Convert, so ownership tracks
 * who was at their desk that morning.
 *
 * Direct clients keep owner scoping: they have no partner, and grouping those
 * on name alone would join unrelated companies across the whole platform.
 *
 * The one thing this gives up is that two genuinely different companies under
 * one firm with the same trimmed, case-folded name are now one client here, as
 * they already are on the firm console. That is the same tradeoff the roster
 * makes, made in the same place, and the alternative — the status quo — is a
 * deliverable that under-reports a client's own history.
 */

export interface CompanyHistoryRef {
  user_id: string;
  partner_id: string | null;
  company_name: string;
}

export interface CompanyHistoryFilter {
  /** SQL predicate over a `valuations v`, binding exactly `$1` and `$2`. */
  clause: string;
  /** The two bindings, in order. A caller's own params start at `$3`. */
  params: [string, string];
}

export function sameCompanyFilter(valuation: CompanyHistoryRef): CompanyHistoryFilter {
  const name = 'lower(trim(v.company_name)) = lower(trim($2))';
  return valuation.partner_id
    ? { clause: `v.partner_id = $1 AND ${name}`, params: [valuation.partner_id, valuation.company_name] }
    : { clause: `v.user_id = $1 AND ${name}`, params: [valuation.user_id, valuation.company_name] };
}

/** How `lower(trim(company_name))` folds in SQL, in TypeScript. */
const foldName = (name: string): string => name.trim().toLowerCase();

/**
 * The same equivalence class as {@link sameCompanyFilter}, decided between two
 * rows already in hand rather than in a WHERE clause.
 *
 * The value bridge needs the predicate rather than the filter: it is handed two
 * valuation ids and has to say whether they are two periods of one client's
 * history before it will draw a bridge between them. Expressed here so it cannot
 * answer differently from the query that produced the candidate list the user
 * picked from — a candidate list offering a valuation the guard then refuses is
 * the worst of both spellings.
 *
 * A partner-owned valuation and a direct one never match, even under the same
 * name: neither one's filter would return the other, and joining them would put
 * a firm's engagement and a self-serve account's into one company's history.
 */
export function sameCompany(a: CompanyHistoryRef, b: CompanyHistoryRef): boolean {
  if (foldName(a.company_name) !== foldName(b.company_name)) return false;
  if (a.partner_id !== b.partner_id) return false;
  return a.partner_id !== null || a.user_id === b.user_id;
}
