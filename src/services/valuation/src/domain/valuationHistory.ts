import { DEFAULT_HEADLINE_LABELS, headlineLabels, isSpecialtyKind } from './specialty.js';
import { VALUATION_KINDS, type ValuationKind } from './valuation.js';

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
  /*
   * Archived engagements are out of a client's history, for the same reason
   * `repos/valuations.buildValuationWhere` puts `archived_at IS NULL` in the
   * builder rather than in its callers: every read that has to remember is a
   * read that will forget. All three callers here did — the report's trend
   * chart, the analytics series and the bridge's candidate list each scanned
   * `valuations v` with no archived clause at all.
   *
   * What that cost is worse than a stale list, because none of these three
   * surfaces is a list of engagements the user is picking from. The trend chart
   * plots a withdrawn valuation's concluded FMV as a point on a *signed* PDF,
   * under a note asserting every point is a prior valuation of this company.
   * The analytics series can seat an archived run as the newest row, which is
   * the row the whole benchmark block is computed from. And the bridge offers
   * one as a comparison candidate, so a firm is invited to explain this year's
   * change against a valuation it retired.
   *
   * Retirement is reversible (`archived_at` is nulled on restore), so this is
   * not data loss — an unarchived engagement comes straight back onto the line.
   */
  const live = 'v.archived_at IS NULL';
  return valuation.partner_id
    ? {
        clause: `v.partner_id = $1 AND ${name} AND ${live}`,
        params: [valuation.partner_id, valuation.company_name],
      }
    : {
        clause: `v.user_id = $1 AND ${name} AND ${live}`,
        params: [valuation.user_id, valuation.company_name],
      };
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

/**
 * Which of a client's engagements belong on one FMV trend line.
 *
 * "Same company" is not the whole question. The chart on the summary page is
 * titled "Fair market value per common share over time" and its note says the
 * points are each prior valuation's *concluded FMV*, and it draws them from
 * `calculations.fmv_per_share`. That column is a 409A column by name and every
 * specialty engine writes into it, because it is the column the row has
 * (`specialtyHeadline`) — so a UK company running an EMI scheme valuation
 * alongside its 409A had the EMI's **actual** market value plotted on the same
 * line. The AMV is the *restricted* figure, below the unrestricted value by the
 * restriction discount, and it is not a fair market value per common share. The
 * chart showed a fall the company did not have, on a signed deliverable, under
 * a note asserting the points were something else.
 *
 * Decided by the caption rather than by a hand-written list of kinds: a run
 * belongs on this line exactly when the figure in that column is the figure the
 * line is named after, which is what {@link headlineLabels} already records for
 * every kind and what the exhibits and the exported workbook already print. An
 * ESOP run is on it — its per-share conclusion is a fair market value per share
 * — and EMI and CSOP are not, along with every kind that concludes no per-share
 * figure at all and so has nothing to plot.
 */
export const FMV_TREND_KINDS: readonly ValuationKind[] = VALUATION_KINDS.filter(
  (kind) => headlineLabels(kind).perShare === DEFAULT_HEADLINE_LABELS.perShare,
);

/**
 * Which of a client's engagements the analytics series can read at all.
 *
 * A different question from {@link FMV_TREND_KINDS} and a different answer, for
 * a reason worth stating: the trend chart reads the typed *column*, which every
 * engine populates, so it asks what the column holds. The analytics endpoint
 * reads the stored `results` **document**, and every series it derives — DLOM,
 * volatility, the applied market multiple, the comparable set behind the
 * benchmark — is a 409A key. A specialty run persists `{ kind, specialty }` and
 * has none of them, so it entered the series as a point with every value null
 * and, worse, as `latest`: the benchmark block is computed from the most recent
 * row alone, so a company whose newest engagement was an EMI valuation got an
 * empty comparable set and a null percentile on its 409A's analytics — a
 * measurement silently replaced by nothing rather than reported as unavailable.
 */
export const ENGINE_409A_KINDS: readonly ValuationKind[] = VALUATION_KINDS.filter(
  (kind) => !isSpecialtyKind(kind),
);
