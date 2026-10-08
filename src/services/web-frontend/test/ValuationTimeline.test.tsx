import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ValuationTimeline } from '../src/components/ValuationTimeline';

function renderTimeline() {
  return render(
    <MemoryRouter>
      <ValuationTimeline />
    </MemoryRouter>,
  );
}

describe('ValuationTimeline', () => {
  it('renders all five timeline steps', () => {
    renderTimeline();
    expect(screen.getByTestId('timeline-step-engagement')).toBeTruthy();
    expect(screen.getByTestId('timeline-step-data-collection')).toBeTruthy();
    expect(screen.getByTestId('timeline-step-analysis')).toBeTruthy();
    expect(screen.getByTestId('timeline-step-draft-report')).toBeTruthy();
    expect(screen.getByTestId('timeline-step-final-report')).toBeTruthy();
  });

  it('renders the heading and average timeline', () => {
    renderTimeline();
    expect(screen.getByText('How your 409A valuation works')).toBeTruthy();
    expect(screen.getAllByText(/Average: 2–3 weeks/).length).toBeGreaterThanOrEqual(1);
  });

  it('expands a step when clicked and collapses when clicked again', async () => {
    const user = userEvent.setup();
    renderTimeline();

    expect(screen.queryByText(/Kick off your valuation/)).toBeNull();

    const buttons = screen.getAllByRole('button');
    await user.click(buttons[0]!);

    expect(screen.getByText(/Kick off your valuation/)).toBeTruthy();

    await user.click(buttons[0]!);
    expect(screen.queryByText(/Kick off your valuation/)).toBeNull();
  });

  it('shows detail items when expanded', async () => {
    const user = userEvent.setup();
    renderTimeline();

    const buttons = screen.getAllByRole('button');
    await user.click(buttons[2]!);

    expect(screen.getByText(/OPM backsolve/)).toBeTruthy();
    expect(screen.getByText(/DLOM analysis/)).toBeTruthy();
  });

  it('only expands one step at a time', async () => {
    const user = userEvent.setup();
    renderTimeline();

    const buttons = screen.getAllByRole('button');
    await user.click(buttons[0]!);
    expect(screen.getByText(/Kick off your valuation/)).toBeTruthy();

    await user.click(buttons[1]!);
    expect(screen.queryByText(/Kick off your valuation/)).toBeNull();
    expect(screen.getByText(/gather and verify/)).toBeTruthy();
  });
});
