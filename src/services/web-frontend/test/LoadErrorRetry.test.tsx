import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { LoadError, useRetry, Spinner } from '../src/components/ui';
import { EngagementsPage } from '../src/pages/EngagementsPage';
import { HealthTab } from '../src/pages/valuation/HealthTab';
import type { Valuation } from '../src/lib/types';

/**
 * R188 — the way back from a failed load.
 *
 * The census beside this one (retryableLoadCensus) proves no surface returns a
 * dead-end error note any more. This proves the thing that replaced them
 * actually works, which is a different claim: a Retry button that renders but
 * re-runs nothing looks answered and is not.
 *
 * Three behaviours, and the third is the one that would have been left out:
 *
 *   1. the failed load can be run again, in place, and the surface arrives;
 *   2. a retry that fails again says so, and offers the retry once more;
 *   3. focus survives it. Retrying unmounts the note, so on a second failure
 *      the note is a *different* element and focus has fallen to `<body>` —
 *      which puts a keyboard user back at the top of the page for every
 *      attempt against a service that is still coming up.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failure = () =>
  new Response(JSON.stringify({ status: 503, title: 'Service Unavailable' }), {
    status: 503,
    headers: { 'content-type': 'application/problem+json' },
  });

describe('LoadError', () => {
  it('states the failure and offers the retry beside it', async () => {
    const onRetry = vi.fn();
    render(<LoadError message="Could not load the engagement pipeline." onRetry={onRetry} />);

    // One alert, so the failure is announced rather than merely drawn.
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the engagement pipeline.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not take focus on the first failure', () => {
    // A page whose load fails has not been interacted with. Moving focus into
    // it would throw away wherever the reader actually was.
    render(<LoadError message="Could not load." onRetry={() => {}} />);
    expect(document.body).toHaveFocus();
  });

  it('takes focus back when it is mounted by a failed retry', () => {
    render(<LoadError message="Could not load." onRetry={() => {}} refocus />);
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus();
  });
});

describe('useRetry', () => {
  /** A surface in miniature: one load, keyed on the retry token. */
  function Probe({ load }: { load: () => Promise<string> }) {
    const [data, setData] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { token, retryProps } = useRetry(() => setError(null));
    useEffect(() => {
      let live = true;
      load()
        .then((d) => live && setData(d))
        .catch(() => live && setError('Could not load the thing.'));
      return () => {
        live = false;
      };
    }, [load, token]);
    if (error) return <LoadError message={error} {...retryProps} />;
    if (!data) return <Spinner />;
    return <p>{data}</p>;
  }

  it('re-runs the load, and asks for focus back only after the first attempt', async () => {
    let attempt = 0;
    const load = () => {
      attempt += 1;
      return attempt < 3 ? Promise.reject(new Error('down')) : Promise.resolve('arrived');
    };
    render(<Probe load={load} />);

    // First failure: the note is there and focus has not moved.
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the thing.');
    expect(document.body).toHaveFocus();

    // Second attempt fails too — the note comes back, and this time it takes
    // the focus, because the reader was on the button that caused it.
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus());
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the thing.');

    // Third arrives.
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('arrived')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(attempt).toBe(3);
  });

  it('takes the note down for the duration of the attempt', async () => {
    // Without the `reset`, the effect re-runs behind a note that never moves:
    // nothing tells the reader the retry is happening, and a retry that
    // succeeds leaves the stale error on screen for good.
    let release: ((value: string) => void) | undefined;
    let attempt = 0;
    const load = () => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('down'));
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    render(<Probe load={load} />);
    await screen.findByRole('alert');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    release!('arrived');
    expect(await screen.findByText('arrived')).toBeInTheDocument();
  });
});

describe('a real page: the engagement pipeline', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  const pipeline = {
    engagements: [
      {
        valuation_id: '01N409VAL000000000000000AA',
        company_name: 'Acme Robotics, Inc.',
        kind: '409a',
        valuation_state: 'started',
        current_stage: 'intake',
        analyst_email: null,
        stage_entered_at: '2026-06-01T00:00:00Z',
        sla: { label: 'On time', elapsedHours: 2, expectedHours: 48, overdue: false, level: 'green' },
      },
    ],
    stages: [{ key: 'intake', label: 'Intake' }],
    truncated: false,
  };

  it('comes back from a failed load without reloading the document', async () => {
    let attempt = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempt += 1;
      return attempt === 1 ? failure() : jsonResponse(pipeline);
    });

    render(
      <MemoryRouter>
        <EngagementsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the engagement pipeline.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Acme Robotics, Inc.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(attempt).toBe(2);
  });
});

describe('a real workspace tab: health', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  const valuation = {
    id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    kind: '409a',
    state: 'drafted',
    company_name: 'Acme',
    user_id: 'u1',
    currency: 'USD',
  } as unknown as Valuation;

  it('retries the tab’s own load rather than the whole workspace', async () => {
    let attempt = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempt += 1;
      return attempt === 1
        ? failure()
        : jsonResponse({
            health_checks: [],
            latest_calculation_id: null,
            gate: { satisfied: false, health_check_id: null, severity: null, blocking: null },
          });
    });

    render(
      <MemoryRouter initialEntries={['/health']}>
        <Routes>
          <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
            <Route path="/health" element={<HealthTab />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByTestId('health-gate-banner')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
