/**
 * Missing-data completeness scoring — what an engagement still needs before a
 * valuation can be run, and how close it is.
 *
 * Distinct from the two neighbours it sits between:
 *
 *   * `intake.computeCompletion` counts answered required fields on the
 *     questionnaire. It is a progress bar for the client filling in a form and
 *     knows nothing about documents, extracted financials or what the
 *     valuation is configured to do.
 *   * `healthChecks` grades a calculation that has already run.
 *
 * This is the gap between them: the evidence base, judged before the engine is
 * dispatched, so an analyst finds out that the market approach has no metric
 * to strike against *now* rather than from a 422 twenty minutes into a
 * deadline.
 *
 * The design centre is that completeness is not a property of an engagement on
 * its own — it is a property of an engagement *relative to what it has been
 * configured to do*. A missing projection is fatal when the income approach
 * carries 40% of the weight and irrelevant when it carries none. A missing
 * `revenue_ntm` is fatal only when `market_horizon` is `ntm`. Scoring every
 * engagement against one fixed checklist produces the two failures that make
 * checklists get ignored: it demands documents the configured model will never
 * read, and it stays quiet about the one figure that will actually stop the
 * run.
 *
 * Pure — no I/O — so every rule is unit-testable.
 */

import { computeCompletion, isAnswered, type IntakeCompletion } from './intake.js';
import { intakeSectionsFor } from './intakeKinds.js';
import { DOCUMENT_CATEGORY_DEFS, type DocumentCategory } from './documentCategories.js';
import type { ValuationKind } from './valuation.js';

/**
 * How badly a gap hurts.
 *
 *   `blocking`  — the configured model cannot produce a number without it.
 *   `important` — the model will run, but a reviewer will ask about it.
 *   `optional`  — worth having; nothing depends on it.
 */
export type GapSeverity = 'blocking' | 'important' | 'optional';

export type GapCategory = 'questionnaire' | 'documents' | 'financials' | 'cap_table' | 'parameters';

export interface CompletenessGap {
  key: string;
  category: GapCategory;
  severity: GapSeverity;
  /** What is missing, in the analyst's words. */
  label: string;
  /** Why it matters *for this engagement* — usually names the setting that made it matter. */
  detail: string;
  /** The specific next action. */
  remedy: string;
}

/**
 * Weight each severity carries in the score.
 *
 * Deliberately steep. On a flat count, an engagement with forty answered
 * questionnaire fields and no cap table scores in the nineties, which is a
 * number that says "nearly there" about something that cannot be modelled at
 * all. The ratio is what stops the score from being reassuring in exactly the
 * case where it should not be.
 */
const WEIGHT: Record<GapSeverity, number> = { blocking: 8, important: 3, optional: 1 };

export type CompletenessGrade = 'ready' | 'nearly' | 'partial' | 'insufficient';

export interface CompletenessReport {
  /** 0–100, weighted by severity. A progress indicator, never a gate. */
  score: number;
  grade: CompletenessGrade;
  /**
   * Whether the engagement can be modelled at all — no blocking gaps.
   *
   * This, not `score`, is the thing to gate on. They are separate fields
   * because a percentage used as a gate is how "95% complete" comes to mean
   * "unusable": the missing 5% is not a random 5%.
   */
  ready: boolean;
  gaps: CompletenessGap[];
  counts: Record<GapSeverity, number>;
  /** Gap counts per category, for the tab headings. */
  byCategory: Record<GapCategory, number>;
  /** The questionnaire's own progress, passed through for the intake console. */
  questionnaire: IntakeCompletion;
}

// ── input shapes ─────────────────────────────────────────────────────────────

/** Only the params this module reads — a subset of ValuationParamsRow. */
export interface CompletenessParams {
  weight_asset?: unknown;
  weight_opm?: unknown;
  weight_income?: unknown;
  weight_market?: unknown;
  market_method?: unknown;
  market_horizon?: unknown;
  allocation_method?: unknown;
  dlom_method?: unknown;
  exit_timeline?: unknown;
  [key: string]: unknown;
}

export interface CompletenessDocument {
  category?: string | null;
}

export interface CompletenessSubject {
  kind: ValuationKind;
  /** Questionnaire answers as submitted. */
  answers?: Record<string, unknown> | null;
  /** Uploaded documents — only the category is read. */
  documents?: readonly CompletenessDocument[] | null;
  /** Extracted engine inputs (revenue_ltm, volatility, cash, …). */
  engineInputs?: Record<string, unknown> | null;
  params?: CompletenessParams | null;
  /** Cap-table share classes, if the engagement has a modelled one. */
  shareClasses?: readonly unknown[] | null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A weight that is actually carrying some of the conclusion. */
const weighted = (v: unknown): boolean => (num(v) ?? 0) > 0;

/**
 * The engine input a market multiple would be struck against.
 *
 * Mirrors `compute._MARKET_METRIC_KEYS`. The pair matters: an 8.0x against
 * trailing revenue when the params asked for forward revenue understates a
 * growing company by its whole growth rate, so "a revenue figure is present"
 * is not the question — "the revenue figure for the configured horizon is
 * present" is.
 */
const MARKET_METRIC_KEYS: Record<string, Record<string, string>> = {
  revenue: { ltm: 'revenue_ltm', ntm: 'revenue_ntm' },
  ebitda: { ltm: 'ebitda_ltm', ntm: 'ebitda_ntm' },
};

const HORIZON_LABEL: Record<string, string> = { ltm: 'last twelve months', ntm: 'next twelve months' };

// ── the rules ────────────────────────────────────────────────────────────────

function questionnaireGaps(subject: CompletenessSubject): CompletenessGap[] {
  const answers = subject.answers ?? {};
  const gaps: CompletenessGap[] = [];
  for (const section of intakeSectionsFor(subject.kind)) {
    const missing = section.fields.filter((f) => f.required && !isAnswered(answers[f.key]));
    if (missing.length === 0) continue;
    gaps.push({
      key: `questionnaire.${section.key}`,
      category: 'questionnaire',
      severity: 'important',
      label: `${section.title}: ${missing.length} required answer${missing.length === 1 ? '' : 's'} outstanding`,
      // Named rather than counted: "3 outstanding" sends someone hunting
      // through a form, and the whole point of this report is to remove that
      // step.
      detail: `Unanswered: ${missing.map((f) => f.label).join(', ')}.`,
      remedy: 'Ask the client to complete the section, or record the answer on their behalf.',
    });
  }
  return gaps;
}

function documentGaps(subject: CompletenessSubject): CompletenessGap[] {
  const present = new Set(
    (subject.documents ?? [])
      .map((d) => (typeof d.category === 'string' ? d.category : null))
      .filter((c): c is string => c !== null),
  );
  const gaps: CompletenessGap[] = [];
  for (const def of DOCUMENT_CATEGORY_DEFS) {
    if (def.key === 'uploads' || present.has(def.key)) continue;
    if (!def.required) continue;
    gaps.push({
      key: `documents.${def.key}`,
      category: 'documents',
      severity: 'blocking',
      label: `No ${def.label.toLowerCase()} uploaded`,
      detail: def.description,
      remedy: `Request the ${def.label.toLowerCase()} from the client.`,
    });
  }
  return gaps;
}

/**
 * Documents that are not required in general but are required by *this*
 * engagement's configuration — the income approach's projections being the
 * case that comes up every week.
 */
const APPROACH_DOCUMENTS: readonly {
  category: DocumentCategory;
  weight: keyof CompletenessParams;
  approach: string;
}[] = [
  { category: 'projections', weight: 'weight_income', approach: 'income (DCF)' },
  { category: 'balance_sheets', weight: 'weight_asset', approach: 'asset' },
];

function approachDocumentGaps(subject: CompletenessSubject): CompletenessGap[] {
  const params = subject.params ?? {};
  const present = new Set((subject.documents ?? []).map((d) => d.category));
  const gaps: CompletenessGap[] = [];
  for (const rule of APPROACH_DOCUMENTS) {
    if (!weighted(params[rule.weight]) || present.has(rule.category)) continue;
    const def = DOCUMENT_CATEGORY_DEFS.find((d) => d.key === rule.category);
    gaps.push({
      key: `documents.${rule.category}.weighted`,
      category: 'documents',
      severity: 'important',
      label: `No ${def?.label.toLowerCase() ?? rule.category} for a weighted ${rule.approach} approach`,
      detail:
        `The ${rule.approach} approach carries ${((num(params[rule.weight]) ?? 0) * 100).toFixed(0)}% ` +
        'of the concluded value, and nothing has been uploaded to support it.',
      remedy: `Upload the ${def?.label.toLowerCase() ?? rule.category}, or re-weight the approach.`,
    });
  }
  return gaps;
}

function capTableGaps(subject: CompletenessSubject): CompletenessGap[] {
  const inputs = subject.engineInputs ?? {};
  const classes = subject.shareClasses ?? [];
  if (classes.length > 0) return [];
  if (num(inputs.shares_outstanding_common) !== null) return [];
  return [
    {
      key: 'cap_table.share_classes',
      category: 'cap_table',
      severity: 'blocking',
      label: 'No cap table modelled',
      detail:
        'Neither share classes nor a common share count are recorded, so there is nothing to ' +
        'allocate equity value across and no denominator for a per-share figure.',
      remedy: 'Model the cap table from the uploaded documents.',
    },
  ];
}

function financialGaps(subject: CompletenessSubject): CompletenessGap[] {
  const params = subject.params ?? {};
  const inputs = subject.engineInputs ?? {};
  const gaps: CompletenessGap[] = [];

  // Market: the metric for the *configured* horizon, not any revenue figure.
  if (weighted(params.weight_market)) {
    const method = typeof params.market_method === 'string' ? params.market_method : null;
    const horizon = typeof params.market_horizon === 'string' ? params.market_horizon : 'ltm';
    if (!method) {
      gaps.push({
        key: 'parameters.market_method',
        category: 'parameters',
        severity: 'blocking',
        label: 'Market approach is weighted but no metric is selected',
        detail:
          'The market approach carries part of the conclusion, but nothing says whether the ' +
          'multiple is struck against revenue or EBITDA.',
        remedy: 'Set the market method to revenue or EBITDA.',
      });
    } else {
      // An unrecognised method/horizon pair yields no key, and no gap: this
      // module reports missing evidence, and a params value the schema should
      // never have admitted is a different complaint belonging to a different
      // check. Inventing a "missing revenue_undefined" gap here would send an
      // analyst looking for a figure that has no field.
      const key = MARKET_METRIC_KEYS[method]?.[horizon];
      const other = MARKET_METRIC_KEYS[method]?.[horizon === 'ntm' ? 'ltm' : 'ntm'];
      if (key && num(inputs[key]) === null) {
        gaps.push({
          key: `financials.${key}`,
          category: 'financials',
          severity: 'blocking',
          label: `No ${horizon.toUpperCase()} ${method} to strike the multiple against`,
          detail:
            `The market approach is configured for the ${HORIZON_LABEL[horizon] ?? horizon} ` +
            `${method} multiple, so \`${key}\` is the figure it needs. ` +
            (other && num(inputs[other]) !== null
              ? `\`${other}\` is present, but the two horizons are not interchangeable — ` +
                'a forward multiple against a trailing metric understates a growing company ' +
                'by its growth rate.'
              : 'Neither horizon has been extracted.'),
          remedy: `Extract or enter ${key}, or switch the market horizon to the one you have.`,
        });
      } else if (key && (num(inputs[key]) ?? 0) <= 0) {
        // A negative or zero denominator makes a multiple meaningless rather
        // than small, and negative EBITDA is routine for a venture-backed
        // company — so this is a configuration question, not bad data.
        gaps.push({
          key: `financials.${key}.nonpositive`,
          category: 'financials',
          severity: 'blocking',
          label: `${horizon.toUpperCase()} ${method} is not positive`,
          detail:
            `\`${key}\` is ${num(inputs[key])}, and a multiple struck against a non-positive ` +
            'denominator is meaningless rather than small.',
          remedy: 'Value on revenue instead, or weight the market approach to zero.',
        });
      }
    }
  }

  // Income: the forecast the DCF discounts.
  if (weighted(params.weight_income)) {
    const income = inputs.income;
    const flows =
      income && typeof income === 'object' && !Array.isArray(income)
        ? (income as Record<string, unknown>).free_cash_flows
        : null;
    if (!Array.isArray(flows) || flows.length === 0) {
      gaps.push({
        key: 'financials.free_cash_flows',
        category: 'financials',
        severity: 'blocking',
        label: 'Income approach is weighted but there is no forecast to discount',
        detail:
          'The income approach carries part of the conclusion and no free cash flow series has ' +
          'been extracted from the projections.',
        remedy: 'Extract the projections, or re-weight the income approach to zero.',
      });
    }
  }

  // Volatility: needed by the OPM allocation and by every model DLOM.
  const allocation = typeof params.allocation_method === 'string' ? params.allocation_method : 'opm';
  const modelDlom = ['chaffee', 'finnerty', 'ghaidarov', 'longstaff'].includes(
    String(params.dlom_method ?? ''),
  );
  const needsVolatility = allocation === 'opm' || allocation === 'hybrid' || modelDlom;
  if (needsVolatility && num(inputs.volatility) === null) {
    gaps.push({
      key: 'financials.volatility',
      category: 'financials',
      severity: 'blocking',
      label: 'No volatility',
      detail: modelDlom
        ? `The ${String(params.dlom_method)} DLOM is derived from volatility and time to exit.`
        : `The ${allocation.toUpperCase()} allocation prices a Black-Scholes call on equity value.`,
      remedy: 'Run the volatility estimator against the guideline companies, or enter it directly.',
    });
  }

  return gaps;
}

function parameterGaps(subject: CompletenessSubject): CompletenessGap[] {
  const params = subject.params ?? {};
  const gaps: CompletenessGap[] = [];

  const weights = [params.weight_asset, params.weight_opm, params.weight_income, params.weight_market];
  const total = weights.reduce<number>((sum, w) => sum + (num(w) ?? 0), 0);
  if (total <= 0) {
    gaps.push({
      key: 'parameters.weights',
      category: 'parameters',
      severity: 'blocking',
      label: 'No approach is weighted',
      detail: 'Every approach weight is zero or unset, so there is nothing to conclude from.',
      remedy: 'Weight the approaches this engagement will conclude on.',
    });
  }

  if (!isAnswered(params.exit_timeline)) {
    gaps.push({
      key: 'parameters.exit_timeline',
      category: 'parameters',
      severity: 'important',
      label: 'No exit timeline',
      detail:
        'Time to exit sets the option term in the allocation and the restriction period in a ' +
        'model DLOM. Without it the engine falls back to a default that nothing in the file ' +
        'justifies.',
      remedy: 'Set the expected exit date.',
    });
  }

  return gaps;
}

// ── the report ───────────────────────────────────────────────────────────────

const ORDER: Record<GapSeverity, number> = { blocking: 0, important: 1, optional: 2 };

/**
 * Grade bands.
 *
 * `ready` is reserved for an engagement with no blocking gaps whatever its
 * score — the grade and the score answer different questions, and an
 * engagement can be short a dozen optional documents and still be entirely
 * modellable.
 */
function gradeFor(score: number, ready: boolean): CompletenessGrade {
  if (ready) return 'ready';
  if (score >= 80) return 'nearly';
  if (score >= 50) return 'partial';
  return 'insufficient';
}

export function scoreCompleteness(subject: CompletenessSubject): CompletenessReport {
  const questionnaire = computeCompletion(subject.answers ?? {}, intakeSectionsFor(subject.kind));

  const gaps = [
    ...parameterGaps(subject),
    ...capTableGaps(subject),
    ...financialGaps(subject),
    ...documentGaps(subject),
    ...approachDocumentGaps(subject),
    ...questionnaireGaps(subject),
  ].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.key.localeCompare(b.key));

  const counts: Record<GapSeverity, number> = { blocking: 0, important: 0, optional: 0 };
  const byCategory: Record<GapCategory, number> = {
    questionnaire: 0,
    documents: 0,
    financials: 0,
    cap_table: 0,
    parameters: 0,
  };
  let lost = 0;
  for (const gap of gaps) {
    counts[gap.severity] += 1;
    byCategory[gap.category] += 1;
    lost += WEIGHT[gap.severity];
  }

  // The denominator is what this engagement could have lost, not a fixed
  // total: an engagement that never weighted the income approach is not
  // penalised for having no projections, and its score is not inflated by
  // "passing" a check that never applied to it either.
  const questionnaireSections = intakeSectionsFor(subject.kind).length;
  const possible =
    questionnaireSections * WEIGHT.important +
    DOCUMENT_CATEGORY_DEFS.filter((d) => d.required).length * WEIGHT.blocking +
    // cap table, weights, volatility/market/income financials, exit timeline
    WEIGHT.blocking * 4 +
    WEIGHT.important * 2;

  // Clamped rather than allowed to go negative: an engagement can in principle
  // fire more weight than `possible` anticipates, and "-20% complete" is not a
  // reading anyone can act on. Zero already says everything it needs to.
  const score = Math.round(100 * (1 - Math.min(1, lost / possible)));
  const ready = counts.blocking === 0;

  return {
    score,
    grade: gradeFor(score, ready),
    ready,
    gaps,
    counts,
    byCategory,
    questionnaire,
  };
}
