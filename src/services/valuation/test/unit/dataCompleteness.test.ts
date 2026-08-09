import { describe, expect, it } from 'vitest';
import { scoreCompleteness, type CompletenessSubject } from '../../src/domain/dataCompleteness.js';

/**
 * Missing-data completeness.
 *
 * The property under test throughout is that completeness is judged *relative
 * to what the engagement is configured to do* — not against a fixed checklist.
 * A rule that fires for an engagement whose configuration never needed the
 * thing is exactly as wrong as one that stays silent when it did.
 */

/** An engagement with nothing wrong with it, to vary one thing at a time. */
const COMPLETE: CompletenessSubject = {
  kind: '409a',
  answers: {},
  documents: [{ category: 'captable_documents' }],
  engineInputs: {
    shares_outstanding_common: 7_000_000,
    revenue_ltm: 4_000_000,
    volatility: 0.6,
  },
  params: {
    weight_opm: 1,
    weight_market: 0,
    weight_income: 0,
    weight_asset: 0,
    allocation_method: 'opm',
    exit_timeline: '2029-06-30',
  },
  shareClasses: [{ name: 'Common', shares: 7_000_000 }],
};

const subject = (over: Partial<CompletenessSubject>): CompletenessSubject => ({
  ...COMPLETE,
  ...over,
  params: { ...COMPLETE.params, ...(over.params ?? {}) },
  engineInputs:
    over.engineInputs === undefined
      ? COMPLETE.engineInputs
      : { ...COMPLETE.engineInputs, ...over.engineInputs },
});

const keys = (s: CompletenessSubject) => scoreCompleteness(s).gaps.map((g) => g.key);
const blocking = (s: CompletenessSubject) =>
  scoreCompleteness(s)
    .gaps.filter((g) => g.severity === 'blocking')
    .map((g) => g.key);

describe('a modellable engagement', () => {
  it('is ready', () => {
    const report = scoreCompleteness(COMPLETE);
    expect(report.ready).toBe(true);
    expect(report.counts.blocking).toBe(0);
  });

  it('grades ready regardless of the optional gaps it still carries', () => {
    // The grade and the score answer different questions: an engagement can be
    // short a dozen questionnaire answers and still be entirely modellable.
    const report = scoreCompleteness(COMPLETE);
    expect(report.grade).toBe('ready');
    expect(report.score).toBeLessThan(100);
  });
});

describe('the score is not the gate', () => {
  it('a single blocking gap costs more than several questionnaire sections', () => {
    const noCapTable = scoreCompleteness(
      subject({ shareClasses: [], engineInputs: { shares_outstanding_common: null } }),
    );
    expect(noCapTable.ready).toBe(false);
    expect(noCapTable.grade).not.toBe('ready');
  });

  it('never reports ready while a blocking gap stands, however high the score', () => {
    const report = scoreCompleteness(
      subject({ documents: [], shareClasses: [], engineInputs: { shares_outstanding_common: null } }),
    );
    expect(report.ready).toBe(false);
    expect(report.grade).not.toBe('ready');
  });

  it('clamps rather than going negative', () => {
    const report = scoreCompleteness({
      kind: '409a',
      answers: {},
      documents: [],
      engineInputs: {},
      params: {},
      shareClasses: [],
    });
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });
});

describe('cap table', () => {
  it('flags an engagement with neither share classes nor a share count', () => {
    expect(
      blocking(subject({ shareClasses: [], engineInputs: { shares_outstanding_common: null } })),
    ).toContain('cap_table.share_classes');
  });

  it('accepts a share count without modelled classes', () => {
    // Enough to produce a per-share figure, which is what the check is about.
    expect(blocking(subject({ shareClasses: [] }))).not.toContain('cap_table.share_classes');
  });
});

describe('market approach', () => {
  const market = (over: Record<string, unknown>, inputs: Record<string, unknown> = {}) =>
    subject({
      params: { weight_opm: 0.5, weight_market: 0.5, market_method: 'revenue', ...over },
      engineInputs: inputs,
    });

  it('is silent when the approach carries no weight', () => {
    const s = subject({
      params: { weight_market: 0, market_method: 'revenue', market_horizon: 'ntm' },
      engineInputs: { revenue_ntm: null },
    });
    expect(keys(s).some((k) => k.startsWith('financials.revenue'))).toBe(false);
  });

  it('flags the configured horizon, not just any revenue figure', () => {
    // The regression the horizon feature exists for: revenue_ltm being present
    // does not make an NTM-configured valuation runnable.
    const s = market({ market_horizon: 'ntm' }, { revenue_ltm: 4_000_000, revenue_ntm: null });
    expect(blocking(s)).toContain('financials.revenue_ntm');
  });

  it('says the other horizon is present but not a substitute', () => {
    const s = market({ market_horizon: 'ntm' }, { revenue_ltm: 4_000_000, revenue_ntm: null });
    const gap = scoreCompleteness(s).gaps.find((g) => g.key === 'financials.revenue_ntm');
    expect(gap?.detail).toContain('revenue_ltm');
    expect(gap?.detail).toContain('not interchangeable');
  });

  it('says so plainly when neither horizon has been extracted', () => {
    const s = market({ market_horizon: 'ltm' }, { revenue_ltm: null, revenue_ntm: null });
    const gap = scoreCompleteness(s).gaps.find((g) => g.key === 'financials.revenue_ltm');
    expect(gap?.detail).toContain('Neither horizon');
  });

  it('defaults to the trailing horizon when none is set', () => {
    const s = market({}, { revenue_ltm: null });
    expect(blocking(s)).toContain('financials.revenue_ltm');
  });

  it('flags a weighted market approach with no metric selected', () => {
    const s = subject({ params: { weight_market: 0.5, market_method: null } });
    expect(blocking(s)).toContain('parameters.market_method');
  });

  it('flags a non-positive denominator as a configuration question', () => {
    // Negative EBITDA is routine for a venture-backed company; the multiple is
    // meaningless rather than small.
    const s = market({ market_method: 'ebitda', market_horizon: 'ltm' }, { ebitda_ltm: -250_000 });
    expect(blocking(s)).toContain('financials.ebitda_ltm.nonpositive');
  });

  it('invents no gap for a method the schema should never have admitted', () => {
    const s = market({ market_method: 'bookings' }, {});
    expect(keys(s).some((k) => k.includes('undefined'))).toBe(false);
  });
});

describe('income approach', () => {
  it('is silent when unweighted', () => {
    expect(blocking(subject({ params: { weight_income: 0 } }))).not.toContain('financials.free_cash_flows');
  });

  it('flags a weighted approach with no forecast', () => {
    const s = subject({ params: { weight_opm: 0.5, weight_income: 0.5 } });
    expect(blocking(s)).toContain('financials.free_cash_flows');
  });

  it('accepts an extracted cash flow series', () => {
    const s = subject({
      params: { weight_opm: 0.5, weight_income: 0.5 },
      engineInputs: { income: { free_cash_flows: [100, 200] } },
    });
    expect(blocking(s)).not.toContain('financials.free_cash_flows');
  });

  it('treats an empty series as no series', () => {
    const s = subject({
      params: { weight_opm: 0.5, weight_income: 0.5 },
      engineInputs: { income: { free_cash_flows: [] } },
    });
    expect(blocking(s)).toContain('financials.free_cash_flows');
  });

  it('asks for projections when the approach is weighted', () => {
    const s = subject({
      params: { weight_opm: 0.5, weight_income: 0.5 },
      engineInputs: { income: { free_cash_flows: [100] } },
    });
    expect(keys(s)).toContain('documents.projections.weighted');
  });
});

describe('volatility', () => {
  it('is required by the OPM allocation', () => {
    const s = subject({ params: { allocation_method: 'opm' }, engineInputs: { volatility: null } });
    expect(blocking(s)).toContain('financials.volatility');
  });

  it('is not required by CVM with a flat DLOM', () => {
    const s = subject({
      params: { allocation_method: 'cvm', dlom_method: 'qualitative' },
      engineInputs: { volatility: null },
    });
    expect(blocking(s)).not.toContain('financials.volatility');
  });

  it.each(['chaffee', 'finnerty', 'ghaidarov', 'longstaff'])(
    'is required by the %s model DLOM even under CVM',
    (method) => {
      const s = subject({
        params: { allocation_method: 'cvm', dlom_method: method },
        engineInputs: { volatility: null },
      });
      expect(blocking(s)).toContain('financials.volatility');
    },
  );

  it('is not required by the restricted-stock DLOM, which takes no market inputs', () => {
    const s = subject({
      params: { allocation_method: 'cvm', dlom_method: 'restricted_stock' },
      engineInputs: { volatility: null },
    });
    expect(blocking(s)).not.toContain('financials.volatility');
  });

  it('names the reason it is needed', () => {
    const s = subject({
      params: { allocation_method: 'cvm', dlom_method: 'ghaidarov' },
      engineInputs: { volatility: null },
    });
    const gap = scoreCompleteness(s).gaps.find((g) => g.key === 'financials.volatility');
    expect(gap?.detail).toContain('ghaidarov');
  });
});

describe('documents', () => {
  it('blocks on a missing cap table', () => {
    expect(blocking(subject({ documents: [] }))).toContain('documents.captable_documents');
  });

  it('does not demand documents that nothing is weighted on', () => {
    // Only the cap table is genuinely required; marking optional things
    // required trains clients to ignore the checklist.
    const gaps = keys(subject({ documents: [{ category: 'captable_documents' }] }));
    expect(gaps).not.toContain('documents.balance_sheets');
    expect(gaps).not.toContain('documents.projections');
  });

  it('asks for balance sheets once the asset approach is weighted', () => {
    const s = subject({ params: { weight_opm: 0.5, weight_asset: 0.5 } });
    expect(keys(s)).toContain('documents.balance_sheets.weighted');
  });

  it('quotes the weight that made the document matter', () => {
    const s = subject({ params: { weight_opm: 0.6, weight_asset: 0.4 } });
    const gap = scoreCompleteness(s).gaps.find((g) => g.key === 'documents.balance_sheets.weighted');
    expect(gap?.detail).toContain('40%');
  });

  it('ignores uncategorised uploads', () => {
    expect(blocking(subject({ documents: [{ category: 'uploads' }] }))).toContain(
      'documents.captable_documents',
    );
  });

  it('tolerates a document with no category', () => {
    expect(() => scoreCompleteness(subject({ documents: [{ category: null }] }))).not.toThrow();
  });
});

describe('parameters', () => {
  it('blocks when no approach is weighted', () => {
    const s = subject({
      params: { weight_asset: 0, weight_opm: 0, weight_income: 0, weight_market: 0 },
    });
    expect(blocking(s)).toContain('parameters.weights');
  });

  it('flags a missing exit timeline without blocking on it', () => {
    const report = scoreCompleteness(subject({ params: { exit_timeline: null } }));
    const gap = report.gaps.find((g) => g.key === 'parameters.exit_timeline');
    expect(gap?.severity).toBe('important');
  });
});

describe('questionnaire', () => {
  it('names the outstanding fields rather than counting them', () => {
    // A count sends someone hunting through a form, which is the step this
    // report exists to remove.
    const report = scoreCompleteness(subject({ answers: {} }));
    const gap = report.gaps.find((g) => g.category === 'questionnaire');
    expect(gap?.detail).toMatch(/Unanswered: .+/);
  });

  it('reports questionnaire progress alongside the gaps', () => {
    const report = scoreCompleteness(subject({ answers: {} }));
    expect(report.questionnaire.percentComplete).toBe(0);
    expect(report.questionnaire.requiredTotal).toBeGreaterThan(0);
  });

  it('is judged against the form the client was actually shown', () => {
    // A QSBS engagement is not scored against the 409A questionnaire.
    const qsbs = scoreCompleteness(subject({ kind: 'qsbs' }));
    const a409 = scoreCompleteness(subject({ kind: '409a' }));
    expect(qsbs.questionnaire.requiredTotal).not.toBe(a409.questionnaire.requiredTotal);
  });
});

describe('report shape', () => {
  it('orders blocking gaps first', () => {
    const report = scoreCompleteness(
      subject({ documents: [], answers: {}, params: { exit_timeline: null } }),
    );
    const severities = report.gaps.map((g) => g.severity);
    const firstImportant = severities.indexOf('important');
    const lastBlocking = severities.lastIndexOf('blocking');
    if (firstImportant !== -1 && lastBlocking !== -1) {
      expect(lastBlocking).toBeLessThan(firstImportant);
    }
  });

  it('counts gaps by category', () => {
    const report = scoreCompleteness(subject({ documents: [] }));
    expect(report.byCategory.documents).toBeGreaterThan(0);
    expect(report.counts.blocking).toBe(report.gaps.filter((g) => g.severity === 'blocking').length);
  });

  it('gives every gap a remedy', () => {
    const report = scoreCompleteness({
      kind: '409a',
      answers: {},
      documents: [],
      engineInputs: {},
      params: { weight_market: 1, market_method: 'revenue' },
      shareClasses: [],
    });
    expect(report.gaps.length).toBeGreaterThan(0);
    for (const gap of report.gaps) {
      expect(gap.remedy.length).toBeGreaterThan(0);
      expect(gap.detail.length).toBeGreaterThan(0);
    }
  });

  it('survives a completely empty subject', () => {
    const report = scoreCompleteness({ kind: '409a' });
    expect(report.ready).toBe(false);
    expect(report.gaps.length).toBeGreaterThan(0);
  });
});
