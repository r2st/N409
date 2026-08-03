import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SearchPage } from '../src/pages/SearchPage';
import type { User } from '../src/lib/types';

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const mockUser = {
  id: '01N409USER00000000000000OP',
  email: 'ops@example.com',
  roles: ['admin'],
} as unknown as User;

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const hit = (name: string) => ({
  id: `01N409VAL0000000000000${name.slice(0, 4).toUpperCase().padEnd(4, 'X')}`,
  company_name: name,
  number: '1',
  kind: '409a',
  state: 'draft',
  created_at: '2026-01-01T00:00:00.000Z',
});

const results = (name: string) => ({ valuations: [hit(name)], users: [] });

/** The search box is debounced, not serialized — replies can cross. */
describe('SearchPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const renderAt = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <SearchPage />
      </MemoryRouter>,
    );

  it('shows the results for the query that was typed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(results('Acme Robotics')));
    renderAt('/search?q=acme');
    await vi.advanceTimersByTimeAsync(300);
    expect(await screen.findByText('Acme Robotics')).toBeInTheDocument();
  });

  const typeQuery = (value: string) =>
    fireEvent.change(screen.getByLabelText('Search'), { target: { value } });

  it('ignores a slow reply that a newer search has already overtaken', async () => {
    // "ac" is issued first but answered last — the classic out-of-order pair
    // the debounce alone does not prevent, because it cancels a pending
    // request, not one already in flight.
    let releaseFirst!: () => void;
    const firstSent = new Promise<void>((r) => {
      releaseFirst = r;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('q=ac&')) {
        await firstSent;
        return jsonResponse(results('Stale Result Co'));
      }
      return jsonResponse(results('Acme Robotics'));
    });

    renderAt('/search?q=ac');
    await vi.advanceTimersByTimeAsync(300); // the "ac" request is now in flight

    typeQuery('acme');
    await vi.advanceTimersByTimeAsync(300);
    expect(await screen.findByText('Acme Robotics')).toBeInTheDocument();

    // Now the overtaken reply lands. It must not repaint the list.
    releaseFirst();
    await vi.advanceTimersByTimeAsync(50);
    await waitFor(() => expect(screen.queryByText('Stale Result Co')).not.toBeInTheDocument());
    expect(screen.getByText('Acme Robotics')).toBeInTheDocument();
  });

  it('keeps a cleared box empty when an in-flight reply arrives', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate;
      return jsonResponse(results('Acme Robotics'));
    });

    renderAt('/search?q=acme');
    await vi.advanceTimersByTimeAsync(300);

    typeQuery('');
    release();
    await vi.advanceTimersByTimeAsync(50);

    expect(await screen.findByText('Type at least two characters to search')).toBeInTheDocument();
    expect(screen.queryByText('Acme Robotics')).not.toBeInTheDocument();
  });
});
