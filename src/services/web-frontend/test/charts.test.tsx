import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DonutChart, WaterfallChart, LineChart, Heatmap } from '../src/components/charts';

describe('DonutChart', () => {
  it('renders a legend entry per non-zero slice and the total in the middle', () => {
    render(
      <DonutChart
        title="By product"
        slices={[
          { label: 'IRC §409A', value: 7 },
          { label: 'ESOP', value: 3 },
          { label: 'QSBS', value: 0 },
        ]}
      />,
    );
    expect(screen.getByText('By product')).toBeInTheDocument();
    expect(screen.getByText('IRC §409A')).toBeInTheDocument();
    expect(screen.getByText('ESOP')).toBeInTheDocument();
    expect(screen.queryByText('QSBS')).not.toBeInTheDocument(); // zero slices are dropped
    expect(screen.getByText('10')).toBeInTheDocument(); // total
  });

  it('shows an empty state when everything is zero', () => {
    render(<DonutChart title="By source" slices={[{ label: 'Ads', value: 0 }]} />);
    expect(screen.getByText('No data in this range.')).toBeInTheDocument();
  });
});

describe('WaterfallChart', () => {
  it('renders the start, each step, and the derived end bar', () => {
    render(
      <WaterfallChart
        title="FMV bridge"
        start={{ label: 'Prior', value: 2 }}
        steps={[
          { label: 'Company value', value: 1.2 },
          { label: 'DLOM', value: 0.3 },
        ]}
        format={(v) => `$${v.toFixed(2)}`}
      />,
    );
    expect(screen.getByText('FMV bridge')).toBeInTheDocument();
    // Start total, step deltas (with sign), and the computed end total.
    expect(screen.getByText('$2.00')).toBeInTheDocument();
    expect(screen.getByText('+$1.20')).toBeInTheDocument();
    expect(screen.getByText('$3.50')).toBeInTheDocument(); // 2 + 1.2 + 0.3
  });
});

describe('LineChart', () => {
  it('renders the latest value and an empty state', () => {
    const { rerender } = render(
      <LineChart
        title="FMV"
        points={[
          { label: 'A', value: 2 },
          { label: 'B', value: 3 },
        ]}
        format={(v) => `$${v.toFixed(2)}`}
      />,
    );
    expect(screen.getByText('FMV')).toBeInTheDocument();
    expect(screen.getByText('$3.00')).toBeInTheDocument(); // latest

    rerender(<LineChart title="FMV" points={[{ label: 'A', value: null }]} format={(v) => `${v}`} />);
    expect(screen.getByText('Not enough data yet.')).toBeInTheDocument();
  });
});

describe('Heatmap', () => {
  const props = {
    title: 'Volatility × Discount rate',
    rowLabel: 'Volatility',
    colLabel: 'Discount rate',
    rowValues: ['48%', '60%'],
    colValues: ['24.0%', '30.0%'],
    format: (v: number) => `$${v.toFixed(2)}`,
  };

  it('renders the axes and each cell', () => {
    render(
      <Heatmap
        {...props}
        cells={[
          [
            { value: 1.8, delta: -0.12 },
            { value: 1.9, delta: -0.07 },
          ],
          [
            { value: 2.05, delta: 0 },
            { value: 2.2, delta: 0.07 },
          ],
        ]}
      />,
    );
    expect(screen.getByText('Volatility × Discount rate')).toBeInTheDocument();
    expect(screen.getByText('48%')).toBeInTheDocument();
    expect(screen.getByText('24.0%')).toBeInTheDocument();
    expect(screen.getByText('$2.05')).toBeInTheDocument();
  });

  // A cell the producer could not value renders as an em dash. The producer
  // generally knows exactly why — the engine names the bound the variation
  // crossed — and that reason is worth more to the reader than the dash.
  it('explains a blank cell instead of leaving a bare dash', () => {
    render(
      <Heatmap
        {...props}
        cells={[
          [
            { value: null, delta: null, note: 'discount_rate must exceed terminal_growth' },
            { value: 1.9, delta: -0.07 },
          ],
          [
            { value: 2.05, delta: 0 },
            { value: 2.2, delta: 0.07 },
          ],
        ]}
      />,
    );
    const blank = screen.getByText('—').closest('td')!;
    expect(blank).toHaveAttribute('title', 'discount_rate must exceed terminal_growth');
    // `title` is hover-only, so the reason is in the accessible name too.
    expect(blank).toHaveTextContent('discount_rate must exceed terminal_growth');
  });

  it('falls back to the delta as the hover when a cell has a value', () => {
    render(
      <Heatmap
        {...props}
        cells={[
          [
            { value: 1.8, delta: -0.12, note: 'ignored — this cell computed' },
            { value: 1.9, delta: -0.07 },
          ],
          [
            { value: 2.05, delta: 0 },
            { value: 2.2, delta: 0.07 },
          ],
        ]}
      />,
    );
    expect(screen.getByText('$1.80').closest('td')!).toHaveAttribute('title', '-12.0%');
  });

  it('marks a blank cell with no stated reason as n/a rather than inventing one', () => {
    render(
      <Heatmap
        {...props}
        cells={[
          [
            { value: null, delta: null },
            { value: 1.9, delta: -0.07 },
          ],
          [
            { value: 2.05, delta: 0 },
            { value: 2.2, delta: 0.07 },
          ],
        ]}
      />,
    );
    expect(screen.getByText('—').closest('td')!).toHaveAttribute('title', 'n/a');
  });
});
