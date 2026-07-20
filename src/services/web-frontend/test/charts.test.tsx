import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DonutChart, WaterfallChart } from '../src/components/charts';

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
