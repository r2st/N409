import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toast } from '../src/components/ui';

afterEach(() => vi.useRealTimers());

describe('Toast (F-4 P3)', () => {
  it('announces info/success via status and errors via alert', () => {
    const { rerender } = render(<Toast message="Saved" tone="success" />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    rerender(<Toast message="Failed" tone="error" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Failed');
  });

  it('auto-dismisses after the duration', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Bye" onDismiss={onDismiss} duration={3000} />);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(3000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a dismissal when duration is 0', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Sticky" onDismiss={onDismiss} duration={0} />);
    act(() => vi.advanceTimersByTime(10000));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses on the close button', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Toast message="Close me" onDismiss={onDismiss} duration={0} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
