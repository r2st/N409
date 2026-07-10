import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExplanationCard } from '../src/components/valuation/ExplanationCard';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const EXPLANATION = {
  explanation: {
    summary: 'Your company was valued at $20M, or $2.00 per common share.',
    methodology: [
      { approach: 'Income approach', weight: 0.6, explanation: 'Discounts projected cash flows.' },
      { approach: 'Market approach', weight: null, explanation: 'Compares to public peers.' },
    ],
    drivers: ['Revenue growth', 'Discount rate'],
    caveats: 'This explanation is informational only.',
  },
  model: 'stub/model',
  generated_at: '2026-07-01T00:00:00Z',
};

describe('ExplanationCard (plain-English summary §4.5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders summary, methodology weights, drivers and caveats', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(EXPLANATION));
    render(<ExplanationCard valuationId="01JZZZZZZZZZZZZZZZZZZZZZZZ" />);

    expect(await screen.findByTestId('explanation-card')).toBeInTheDocument();
    expect(screen.getByText(/valued at \$20M/)).toBeInTheDocument();
    expect(screen.getByText(/Income approach/)).toBeInTheDocument();
    expect(screen.getByText('(60%)')).toBeInTheDocument();
    expect(screen.getByText(/Revenue growth · Discount rate/)).toBeInTheDocument();
    expect(screen.getByText(/informational only/)).toBeInTheDocument();
  });

  it('renders nothing when no explanation is exposed to this role', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ explanation: null, model: null, generated_at: null }),
    );
    const { container } = render(<ExplanationCard valuationId="01JZZZZZZZZZZZZZZZZZZZZZZZ" />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on API errors (purely additive)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 404 }, 404));
    const { container } = render(<ExplanationCard valuationId="01JZZZZZZZZZZZZZZZZZZZZZZZ" />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container).toBeEmptyDOMElement();
  });
});
