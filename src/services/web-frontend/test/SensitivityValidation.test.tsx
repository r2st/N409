import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SensitivityPage } from '../src/pages/SensitivityPage';

/**
 * R29 — the assumption boxes carried `min`/`max`/`step` and nothing restated
 * them once the form stopped asking the browser. Each bound below is the one
 * the control still declares as an attribute; the point of the test is that the
 * page now enforces it too, and says which box is wrong.
 */

const okResponse = () =>
  new Response(
    JSON.stringify({
      sensitivity: {
        currency: 'USD',
        dlom: 0.3,
        base: { volatility: 0.6, termYears: 3, riskFreeRate: 0.043, fmvPerShareCents: 123 },
        volatilities: [0.6],
        terms: [3],
        rows: [[{ fmvPerShareCents: 123, deltaFromBase: 0 }]],
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/valuations/X/sensitivity']}>
      <Routes>
        <Route path="/valuations/:id/sensitivity" element={<SensitivityPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The message `aria-describedby` points at, which is the one next to the box. */
const messageFor = (label: string) => {
  const box = screen.getByLabelText(label);
  expect(box).toHaveAttribute('aria-invalid', 'true');
  return document.getElementById(box.getAttribute('aria-describedby')!);
};

const sensitivityCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([u]) => String(u).includes('/sensitivity'));

describe('SensitivityPage assumption validation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('refuses a volatility above the 500% ceiling the control declares', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const user = userEvent.setup();
    renderPage();

    await user.clear(screen.getByLabelText('Volatility (%)'));
    await user.type(screen.getByLabelText('Volatility (%)'), '600');
    await user.click(screen.getByRole('button', { name: /Run stress table/ }));

    expect(messageFor('Volatility (%)')).toHaveTextContent('Volatility must be at most 500.');
    expect(sensitivityCalls(fetchSpy)).toHaveLength(0);
  });

  it('refuses a term beyond 30 years', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const user = userEvent.setup();
    renderPage();

    await user.clear(screen.getByLabelText('Term to exit (years)'));
    await user.type(screen.getByLabelText('Term to exit (years)'), '45');
    await user.click(screen.getByRole('button', { name: /Run stress table/ }));

    expect(messageFor('Term to exit (years)')).toHaveTextContent('Term must be at most 30.');
    expect(sensitivityCalls(fetchSpy)).toHaveLength(0);
  });

  it('refuses a zero equity value rather than sending it to the OPM', async () => {
    // The model spreads equity across shares; zero equity is a table of zeroes
    // at best, and the API's own floor is 1.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const user = userEvent.setup();
    renderPage();

    await user.clear(screen.getByLabelText('Equity value ($)'));
    await user.type(screen.getByLabelText('Equity value ($)'), '0');
    await user.click(screen.getByRole('button', { name: /Run stress table/ }));

    expect(messageFor('Equity value ($)')).toHaveTextContent('Equity value must be at least 1.');
    expect(sensitivityCalls(fetchSpy)).toHaveLength(0);
  });

  it('refuses a fractional share count, which is what step="1" meant', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const user = userEvent.setup();
    renderPage();

    await user.clear(screen.getByLabelText('Common shares (FD)'));
    await user.type(screen.getByLabelText('Common shares (FD)'), '1000.5');
    await user.click(screen.getByRole('button', { name: /Run stress table/ }));

    expect(messageFor('Common shares (FD)')).toHaveTextContent(
      'Common shares must be a whole number.',
    );
    expect(sensitivityCalls(fetchSpy)).toHaveLength(0);
  });

  it('names an emptied box as required rather than reading it as zero', async () => {
    // `Number('')` is 0, so without the empty case first this would have said
    // "must be at least 1" about a box with nothing in it.
    const user = userEvent.setup();
    renderPage();

    await user.clear(screen.getByLabelText('DLOM (%)'));
    await user.click(screen.getByRole('button', { name: /Run stress table/ }));

    expect(messageFor('DLOM (%)')).toHaveTextContent('DLOM is required.');
  });

  it('flags a bad value on blur, before anything is submitted', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.clear(screen.getByLabelText('Risk-free rate (%)'));
    await user.type(screen.getByLabelText('Risk-free rate (%)'), '90');
    await user.tab();

    expect(await screen.findByText('Risk-free rate must be at most 25.')).toBeInTheDocument();
  });

  it('says nothing about a box that has not been left yet', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.clear(screen.getByLabelText('Risk-free rate (%)'));
    await user.type(screen.getByLabelText('Risk-free rate (%)'), '90');

    expect(screen.queryByText('Risk-free rate must be at most 25.')).not.toBeInTheDocument();
  });

  it('clears the message as soon as the value is corrected', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.clear(screen.getByLabelText('Volatility (%)'));
    await user.click(screen.getByRole('button', { name: /Run stress table/ }));
    expect(await screen.findByText('Volatility is required.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Volatility (%)'), '60');
    expect(screen.queryByText('Volatility is required.')).not.toBeInTheDocument();
  });

  it('still runs the table when every assumption is in range', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: /Run stress table/ }));

    expect(await screen.findByText(/Base FMV/)).toBeInTheDocument();
    expect(sensitivityCalls(fetchSpy)).toHaveLength(1);
  });
});
