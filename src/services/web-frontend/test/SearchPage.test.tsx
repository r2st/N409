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

const results = (name: string) => ({ valuations: [hit(name)], documents: [], users: [] });

const documentHit = (filename: string, company = 'Acme Robotics') => ({
  id: '01N409DOC00000000000000AA',
  valuation_id: '01N409VAL00000000000000AA',
  filename,
  kind: 'other',
  category: null,
  content_type: 'application/pdf',
  size_bytes: '2048',
  created_at: '2026-02-03T00:00:00.000Z',
  company_name: company,
  valuation_number: '42',
});

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

  describe('document hits', () => {
    const withDocuments = (docs: ReturnType<typeof documentHit>[]) => ({
      valuations: [],
      documents: docs,
      users: [],
    });

    it('lists a matching filename', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        jsonResponse(withDocuments([documentHit('cap-table-2026.xlsx')])),
      );
      renderAt('/search?q=cap-table');
      await vi.advanceTimersByTimeAsync(300);

      expect(await screen.findByText('cap-table-2026.xlsx')).toBeInTheDocument();
      expect(screen.getByText('Documents (1)')).toBeInTheDocument();
    });

    it('links a hit to the documents tab of the valuation that owns it', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        jsonResponse(withDocuments([documentHit('board-consent.pdf')])),
      );
      renderAt('/search?q=board');
      await vi.advanceTimersByTimeAsync(300);

      const link = await screen.findByRole('link', { name: 'board-consent.pdf' });
      expect(link).toHaveAttribute('href', '/valuations/01N409VAL00000000000000AA/documents');
    });

    it('shows the owning company, since a filename alone names no engagement', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        jsonResponse(withDocuments([documentHit('cap-table.xlsx', 'Beta Biosciences')])),
      );
      renderAt('/search?q=cap-table');
      await vi.advanceTimersByTimeAsync(300);

      expect(await screen.findByText(/Beta Biosciences/)).toBeInTheDocument();
      expect(screen.getByText('#42')).toBeInTheDocument();
    });

    it('says so when nothing matched, rather than showing an empty table', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(withDocuments([])));
      renderAt('/search?q=nothing');
      await vi.advanceTimersByTimeAsync(300);

      expect(await screen.findByText('No matching documents.')).toBeInTheDocument();
    });

    it('renders an API reply that predates document search instead of crashing', async () => {
      // The frontend and API deploy separately: mid-rollout this build can
      // read a reply with no `documents` key at all. That must degrade to
      // "no documents", not to a blank page.
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        jsonResponse({ valuations: [hit('Acme Robotics')], users: [] }),
      );
      renderAt('/search?q=acme');
      await vi.advanceTimersByTimeAsync(300);

      expect(await screen.findByText('Acme Robotics')).toBeInTheDocument();
      expect(screen.getByText('Documents (0)')).toBeInTheDocument();
    });
  });
});
