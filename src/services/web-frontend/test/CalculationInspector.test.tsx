import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalculationInspector } from '../src/components/valuation/CalculationInspector';
import type { CalculationDetail } from '../src/lib/pipeline';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const DETAIL: CalculationDetail = {
  calculation: {
    id: '01CALC00000000000000000001',
    valuation_id: '01VAL000000000000000000001',
    engine_version: 'py-1.0.0',
    status: 'succeeded',
    inputs: {},
    results: {},
    equity_value: '12000000',
    fmv_per_share: '1.2',
    error: null,
    created_at: '2026-08-01T10:00:00Z',
  },
  request: { params: { weight_income: 1 }, inputs: { shares_outstanding_common: 8_000_000 } },
  response: { fmv_per_share: 1.2 },
  steps: [
    {
      seq: 1,
      key: 'approach.asset',
      label: 'Asset approach',
      status: 'skipped',
      inputs: { weight: 0 },
      outputs: null,
      note: 'zero weight — excluded from the conclusion',
      elapsed_ms: 0.01,
    },
    {
      seq: 2,
      key: 'approach.income',
      label: 'Income approach (DCF)',
      status: 'computed',
      inputs: { weight: 1, discount_rate: 0.25 },
      outputs: { equity_value: 12_000_000 },
      note: null,
      elapsed_ms: 0.4,
    },
    {
      seq: 3,
      key: 'approach.market',
      label: 'Market approach (comparables)',
      status: 'reused',
      inputs: { weight: 0 },
      outputs: { equity_value: 9_000_000 },
      note: 'carried from the previous run — this recalculation did not name it',
      elapsed_ms: 0.42,
    },
  ],
  traced: true,
};

const mockDetail = (over: Partial<CalculationDetail> = {}) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).includes('/calculations/')) return jsonResponse({ ...DETAIL, ...over });
    throw new Error(`unexpected fetch ${String(input)}`);
  });

const renderInspector = () =>
  render(
    <CalculationInspector valuationId="01VAL000000000000000000001" calculationId="01CALC00000000000000000001" />,
  );

/**
 * The step inspector's job is to say things the results document cannot. Each
 * test below is one of those things — not that a list rendered, but that the
 * one fact only this panel carries is legible.
 */
describe('CalculationInspector', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists the pipeline stages in the order the engine ran them', async () => {
    mockDetail();
    renderInspector();
    await waitFor(() => expect(screen.getByText('Asset approach')).toBeInTheDocument());
    const labels = screen.getAllByText(/approach/i).map((el) => el.textContent);
    expect(labels[0]).toBe('Asset approach');
  });

  it('distinguishes a skipped stage from a reused one', async () => {
    // The whole reason this panel exists. Both are absent from
    // `results.approaches` in exactly the same way and mean opposite things:
    // one was excluded on purpose, the other is older than the inputs above it.
    mockDetail();
    renderInspector();
    await waitFor(() => expect(screen.getByText('skipped')).toBeInTheDocument());
    expect(screen.getByText('reused')).toBeInTheDocument();
    expect(screen.getByText(/zero weight/)).toBeInTheDocument();
    expect(screen.getByText(/did not name it/)).toBeInTheDocument();
  });

  it('keeps a stage’s payloads collapsed until asked for', async () => {
    // Seven stages of engine state at once is a JSON dump, which is the thing
    // this panel is meant to replace.
    const user = userEvent.setup();
    mockDetail();
    renderInspector();
    await waitFor(() => expect(screen.getByText('Income approach (DCF)')).toBeInTheDocument());
    expect(screen.queryByText('Consumed')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Income approach/ }));
    expect(await screen.findByText('Consumed')).toBeInTheDocument();
    expect(screen.getByText('Produced')).toBeInTheDocument();
  });

  it('offers the raw request and response for replaying a run by hand', async () => {
    const user = userEvent.setup();
    mockDetail();
    renderInspector();
    await waitFor(() => expect(screen.getByText(/Raw request/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Raw request/ }));
    expect(await screen.findByText('Request to the engine')).toBeInTheDocument();
    expect(screen.getByText('Response from the engine')).toBeInTheDocument();
  });

  it('says a pre-0126 run predates step recording', async () => {
    // Not an empty list. Unexplained emptiness reads as a broken inspector
    // rather than as history.
    mockDetail({ steps: [], traced: false });
    renderInspector();
    expect(await screen.findByText(/predates step recording/)).toBeInTheDocument();
  });

  it('says a rejected payload never reached the pipeline', async () => {
    // The other kind of nothing, and it is a diagnosis rather than an absence.
    mockDetail({
      steps: [],
      traced: true,
      calculation: { ...DETAIL.calculation, status: 'failed', error: 'volatility is required' },
    });
    renderInspector();
    expect(await screen.findByText(/rejected the payload before the pipeline started/)).toBeInTheDocument();
    expect(screen.getByText('volatility is required')).toBeInTheDocument();
  });
});
