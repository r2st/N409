import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DonutChart } from '../src/components/charts';

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
