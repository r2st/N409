import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ValuationsPage } from '../src/pages/ValuationsPage';

/**
 * Filtering the engagement list by tag — the reason the tag vocabulary exists.
 *
 * `routes/valuationTags.ts` justifies operations-only writing on the grounds
 * that "a tag drives the list filter and the precedent query", and the list
 * route has taken `?tags=` since the vocabulary shipped. No control ever sent
 * it. Tagging an engagement was therefore a write with no reader, which is the
 * version of a half-built feature that looks finished from either end.
 *
 * The three things worth pinning are that the picker is built from the served
 * catalogue rather than a copy, that choosing a tag actually reaches the list
 * query, and that a catalogue which fails to load hides the control instead of
 * showing an empty dropdown — "this firm has no tags" is a different claim
 * from "the vocabulary could not be fetched", and only one of them is ever true.
 */

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      email: 'ops@n409.example',
      first_name: 'Olive',
      last_name: 'Ops',
      verified: true,
      sso_provider: null,
      partner_id: null,
      roles: ['admin'],
    },
  }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const BUCKETS = [
  { key: 'all', label: 'All' },
  { key: 'in_progress', label: 'In Progress' },
];

const CATEGORIES = [
  {
    category: 'stage',
    label: 'Stage',
    exclusive: true,
    tags: [{ slug: 'series_a', label: 'Series A', definition: 'Raised a Series A.' }],
  },
  {
    category: 'business_model',
    label: 'Business model',
    exclusive: false,
    tags: [{ slug: 'saas', label: 'SaaS', definition: 'Subscription software.' }],
  },
];

function mockApi({ catalogueFails = false } = {}) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/tag-catalogue')) {
      return catalogueFails ? jsonResponse({}, 500) : jsonResponse({ categories: CATEGORIES });
    }
    if (path.includes('/valuations/counts')) {
      return jsonResponse({ counts: { all: 2, in_progress: 1 }, buckets: BUCKETS });
    }
    if (path.includes('/users/options')) return jsonResponse({ options: [] });
    if (path.includes('/partners')) return jsonResponse({ partners: [] });
    if (path.includes('/valuations?')) {
      return jsonResponse({ valuations: [], page: 1, per_page: 25, total: 0 });
    }
    return jsonResponse({});
  });
  return calls;
}

const renderPage = (entry = '/valuations') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ValuationsPage />
    </MemoryRouter>,
  );

describe('ValuationsPage tag filter', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('offers the served vocabulary, grouped by category', async () => {
    mockApi();
    renderPage();

    const picker = await screen.findByLabelText('Filter by tag');
    expect(picker).toHaveTextContent('Series A');
    expect(picker).toHaveTextContent('SaaS');
    expect(picker.innerHTML).toContain('Stage');
    expect(picker.innerHTML).toContain('Business model');
    // Nothing preselected — a default would silently hide most of the book.
    expect(picker).toHaveValue('');
  });

  it('sends the chosen tag to the list and the counts', async () => {
    const calls = mockApi();
    renderPage();

    await userEvent.selectOptions(await screen.findByLabelText('Filter by tag'), 'saas');

    await waitFor(() =>
      expect(calls.some((c) => c.includes('/valuations?') && c.includes('tags=saas'))).toBe(true),
    );
    // The tab counts above the list have to move with it, or the tabs report
    // platform totals over a filtered list and the two disagree on screen.
    expect(calls.some((c) => c.includes('/valuations/counts') && c.includes('tags=saas'))).toBe(true);
  });

  it('shows a hand-written multi-tag URL as filtered rather than as unfiltered', async () => {
    mockApi();
    renderPage('/valuations?tags=saas,series_a');

    // `tags` is a set on the wire; the control holds one. Showing "Any tag"
    // over a list filtered to two would read as a bug in the list.
    expect(await screen.findByLabelText('Filter by tag')).toHaveValue('saas');
  });

  it('hides the control when the catalogue could not be loaded', async () => {
    mockApi({ catalogueFails: true });
    renderPage();

    // The rest of the page is fine, so there is no banner — but an empty
    // dropdown would say this firm classifies nothing, which is a claim about
    // the data made out of a failed GET.
    await screen.findByLabelText('Filter by state');
    expect(screen.queryByLabelText('Filter by tag')).not.toBeInTheDocument();
  });
});
