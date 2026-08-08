import type pg from 'pg';
import { buildHmrcForm, schemeForKind, type HmrcForm } from '../domain/hmrcForms.js';
import { latestSucceededCalculation } from './calculations.js';
import { findCompanyProfile } from './companyProfiles.js';
import { findQuestionnaire } from './intake.js';
import type { ValuationRow } from './valuations.js';

/**
 * Gathers what domain/hmrcForms.ts needs from the three places it lives.
 *
 * An assembly across repos rather than a repo of its own: the form has no
 * table, it is a projection of the engagement, its questionnaire and its
 * latest engine run. It sits here — beside the queries it makes — because two
 * callers need exactly this bundle and neither should have to know it takes
 * three round trips: the API endpoint an analyst reads before submitting, and
 * the report renderer that prints the same pack as an appendix. Building it
 * once means the PDF and the screen cannot disagree about whether a field is
 * still outstanding.
 */
export async function loadHmrcForm(pool: pg.Pool, valuation: ValuationRow): Promise<HmrcForm | null> {
  if (!schemeForKind(valuation.kind)) return null;

  const [profile, questionnaire, calculation] = await Promise.all([
    findCompanyProfile(pool, valuation.id),
    findQuestionnaire(pool, valuation.id),
    latestSucceededCalculation(pool, valuation.id),
  ]);

  // The specialty run records the engine's output under results.specialty and
  // the payload it was given under inputs.params (routes/specialty.ts). A 409A
  // calculation on the same engagement has neither, and reading it would put
  // common-stock figures on an EMI form — so an unrecognised shape contributes
  // nothing and the form reports the values as not supplied.
  const results = calculation?.results as { specialty?: unknown } | undefined;
  const specialty =
    results?.specialty && typeof results.specialty === 'object'
      ? (results.specialty as Record<string, unknown>)
      : null;
  const payload = calculation?.inputs as { params?: unknown } | undefined;
  const params =
    payload?.params && typeof payload.params === 'object'
      ? (payload.params as Record<string, unknown>)
      : null;

  return buildHmrcForm({
    kind: valuation.kind,
    currency: valuation.currency,
    companyName: valuation.company_name,
    profile,
    answers: (questionnaire?.answers ?? null) as Record<string, unknown> | null,
    specialty,
    params,
  });
}
