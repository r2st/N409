import type pg from 'pg';
import type { FundReportData, DebtReportData } from '../domain/navExhibits.js';
import { findFundByValuation, latestMarks, listPositions, findLpTerms } from './funds.js';
import {
  findCreditTerms,
  findInstrumentByValuation,
  findValuationRun,
  listValuations,
} from './debtInstruments.js';
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

  const [positions, lpTerms] = await Promise.all([listPositions(pool, fund.id), findLpTerms(pool, fund.id)]);
  // After the page, not beside it: the marks this report prints are the ones
  // for the positions it prints.
  const marks = await latestMarks(
    pool,
    positions.positions.map((p) => p.id),
  );

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
  //
  // The head is then re-read in full, because the list no longer carries the
  // two jsonb documents a run is made of — nothing else on this surface reads
  // them, and shipping fifty of them for a two-column table was most of the
  // response. By id rather than by re-asking for the newest, so "the same
  // ordered query" above stays true of exactly one query: a run landing between
  // the two would otherwise make them different answers.
  const head = history.valuations[0] ?? null;
  return {
    instrument,
    creditTerms,
    valuation: head ? await findValuationRun(pool, head.id) : null,
    history: history.valuations,
  };
}
