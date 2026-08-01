import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GettingStarted } from '../src/components/GettingStarted';

/**
 * The checklist used to live entirely in localStorage, so an account with
 * three valuations and a signed board resolution still read "0/8". These pin
 * the fix: real completions tick themselves, and the two sources union.
 */

function wrap(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function progressResponse(steps: string[]): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ steps, completed: steps.length, total: 8, all_done: steps.length === 8 }),
    text: async () => JSON.stringify({ steps }),
  } as unknown as Response;
}

describe('GettingStarted — progress from the account', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('ticks the steps the account has actually completed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(progressResponse(['company', 'financials', 'run']));
    wrap(<GettingStarted />);

    await waitFor(() => expect(screen.getByText('3/8')).toBeInTheDocument());
    const checks = screen.getAllByRole('checkbox');
    expect(checks[0]).toHaveAttribute('aria-checked', 'true'); // company
    expect(checks[1]).toHaveAttribute('aria-checked', 'false'); // cap table
    expect(checks[2]).toHaveAttribute('aria-checked', 'true'); // financials
    expect(checks[5]).toHaveAttribute('aria-checked', 'true'); // run
  });

  it('asks the onboarding endpoint exactly once', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(progressResponse(['company']));
    wrap(<GettingStarted />);

    await waitFor(() => expect(screen.getByText('1/8')).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/onboarding/progress');
  });

  it('unions server progress with steps the user ticked by hand', async () => {
    localStorage.setItem('n409.getting-started.done', JSON.stringify(['cap-table']));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(progressResponse(['company']));
    wrap(<GettingStarted />);

    // One earned, one manual — neither displaces the other.
    await waitFor(() => expect(screen.getByText('2/8')).toBeInTheDocument());
    const checks = screen.getAllByRole('checkbox');
    expect(checks[0]).toHaveAttribute('aria-checked', 'true');
    expect(checks[1]).toHaveAttribute('aria-checked', 'true');
  });

  it('will not let a real completion be un-ticked', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(progressResponse(['company']));
    wrap(<GettingStarted />);

    await waitFor(() => expect(screen.getByText('1/8')).toBeInTheDocument());
    const company = screen.getAllByRole('checkbox')[0]!;
    expect(company).toHaveAttribute('aria-disabled', 'true');

    await user.click(company);
    // Still ticked, and nothing was written to the manual store.
    expect(company).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('1/8')).toBeInTheDocument();
    expect(localStorage.getItem('n409.getting-started.done')).toBeNull();
  });

  it('still allows hand-ticking a step the account has not completed', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(progressResponse(['company']));
    wrap(<GettingStarted />);

    await waitFor(() => expect(screen.getByText('1/8')).toBeInTheDocument());
    await user.click(screen.getAllByRole('checkbox')[1]!);

    expect(screen.getByText('2/8')).toBeInTheDocument();
    expect(localStorage.getItem('n409.getting-started.done')).toContain('cap-table');
  });

  it('celebrates only when every step is genuinely done', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      progressResponse([
        'company',
        'cap-table',
        'financials',
        'methodology',
        'assumptions',
        'run',
        'report',
        'board',
      ]),
    );
    wrap(<GettingStarted />);

    await waitFor(() => expect(screen.getByText('8/8')).toBeInTheDocument());
    expect(screen.getByText(/You're all set/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('falls back to manual ticks when the progress call fails', async () => {
    localStorage.setItem('n409.getting-started.done', JSON.stringify(['company']));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    wrap(<GettingStarted />);

    // Renders rather than erroring, showing what the user ticked themselves.
    expect(await screen.findByText('1/8')).toBeInTheDocument();
    expect(screen.getByText(/step by step/)).toBeInTheDocument();
  });
});
