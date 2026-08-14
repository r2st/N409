import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { CommandPalette } from '../src/components/CommandPalette';
import type { User } from '../src/lib/types';

/**
 * Round 18 of the swallowed-load-error sweep, over the shape the earlier greps
 * did not reach: a `.catch` that discards the failure and leaves a *claim*
 * standing where the answer should have been.
 *
 * The palette answered a search that never came back with "Nothing matches
 * “Acme”" — a statement about the account. It is also how someone finds a
 * valuation they cannot see in the worklist, so that answer sends them looking
 * for an engagement they have just been assured does not exist.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const makeUser = (roles: string[]): User => ({
  id: 'me-1',
  email: 'me@409.ai',
  first_name: 'Mo',
  last_name: 'Admin',
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles,
});

function renderPalette(searchAnswer: () => Response) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/auth/me')) return jsonResponse({ user: makeUser(['admin']) });
    if (path.includes('/search?')) return searchAnswer();
    return jsonResponse({});
  });
  localStorage.setItem('n409.token', 'header.payload.sig');
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <AuthProvider>
        <Routes>
          <Route path="*" element={<CommandPalette />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function openAndType(text: string) {
  await userEvent.keyboard('{Meta>}k{/Meta}');
  await screen.findByRole('dialog', { name: 'Command palette' });
  const box = screen.getByLabelText('Search commands');
  await userEvent.type(box, text);
  return box;
}

describe('CommandPalette — a search that failed is not an account with no match', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says the search is unavailable rather than that nothing matches', async () => {
    renderPalette(() => jsonResponse({ title: 'Service Unavailable', status: 503 }, 503));
    await openAndType('Acme');

    expect(await screen.findByText(/Search is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing matches/)).not.toBeInTheDocument();
  });

  /**
   * The command index is local and never needed the network, so losing the
   * server half must not cost the user their navigation as well.
   */
  it('still lists the pages it matched locally while the server half is down', async () => {
    renderPalette(() => jsonResponse({ title: 'Bad Gateway', status: 502 }, 502));
    await openAndType('settings');

    expect(await screen.findByText(/Search is unavailable/)).toBeInTheDocument();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });

  it('still says nothing matches when the search genuinely comes back empty', async () => {
    renderPalette(() => jsonResponse({ valuations: [], users: [] }));
    await openAndType('zzzqqqxx');

    expect(await screen.findByText(/Nothing matches “zzzqqqxx”/)).toBeInTheDocument();
    expect(screen.queryByText(/Search is unavailable/)).not.toBeInTheDocument();
  });

  /** A blip must not leave the warning up over results that did arrive. */
  it('clears the warning once a later search succeeds', async () => {
    let fail = true;
    renderPalette(() =>
      fail
        ? jsonResponse({ title: 'Service Unavailable', status: 503 }, 503)
        : jsonResponse({ valuations: [], users: [] }),
    );
    const box = await openAndType('Acme');
    expect(await screen.findByText(/Search is unavailable/)).toBeInTheDocument();

    fail = false;
    await userEvent.clear(box);
    await userEvent.type(box, 'Beta');

    await waitFor(() => expect(screen.queryByText(/Search is unavailable/)).not.toBeInTheDocument());
  });
});
