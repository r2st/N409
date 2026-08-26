import type pg from 'pg';
import type { FundReportData, DebtReportData } from '../domain/navExhibits.js';
import { findFundByValuation, latestMarks, listPositions, findLpTerms } from './funds.js';
import { findCreditTerms, findInstrumentByValuation, listValuations } from './debtInstruments.js';
import type { ValuationRow } from './valuations.js';

/**
 * Gathers what domain/navExhibits.ts needs for the two measurement kinds.
 *
 * The same shape as repos/hmrcForms.ts: an assembly across repos rather than a
 * repo of its own, sitting beside the queries it makes so neither caller has
 * to know how many round trips a fund pack takes. Both loaders return null for
 * a kind they do not serve, and for an engagement with no linked measurement
 * subject (migration 0109) — a `fund` engagement nobody has attached a
 * portfolio to renders its authored body and no schedules, which is the honest
 * output, rather than an empty NAV table implying a portfolio worth nothing.
 */

export async function loadFundReport(pool: pg.Pool, valuation: ValuationRow): Promise<FundReportData | null> {
  if (valuation.kind !== 'fund') return null;
  const fund = await findFundByValuation(pool, valuation.id);
  if (!fund) return null;

  const [positions, marks, lpTerms] = await Promise.all([
    listPositions(pool, fund.id),
    latestMarks(pool, fund.id),
    findLpTerms(pool, fund.id),
  ]);

  return {
    fund,
    positions: positions.positions.map((position) => ({
      position,
      mark: marks.get(position.id) ?? null,
    })),
    lpTerms,
  };
}

export async function loadDebtReport(pool: pg.Pool, valuation: ValuationRow): Promise<DebtReportData | null> {
  if (valuation.kind !== 'debt') return null;
  const instrument = await findInstrumentByValuation(pool, valuation.id);
  if (!instrument) return null;

  const [creditTerms, history] = await Promise.all([
    findCreditTerms(pool, instrument.id),
    listValuations(pool, instrument.id),
  ]);

  // listValuations is newest-first, so the head is the measurement the report
  // speaks for. An instrument linked but never priced yields no result exhibit
  // and no cash-flow schedule, but still prints its terms.
  //
  // The page cap is not carried onto the report: the exhibit prints the history
  // it was handed, and DEBT_VALUATION_PAGE_LIMIT is fifty measurements of one
  // instrument. What the report must never do is take a *different* head from
  // the one the screen shows, which is why both read the same ordered query.
  return {
    instrument,
    creditTerms,
    valuation: history.valuations[0] ?? null,
    history: history.valuations,
  };
}
