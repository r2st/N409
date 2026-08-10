import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminHelpPage } from '../src/pages/AdminHelpPage';

const ARTICLES = [
  {
    id: '01JHELP0000000000000000001',
    slug: 'getting-started',
    title: 'Getting started',
    category: 'Basics',
    keywords: 'intro onboarding first',
    body_html: '<p>Start here.</p>',
    sort_order: 10,
    published: true,
    updated_at: '2026-07-01T10:00:00Z',
  },
  {
    id: '01JHELP0000000000000000002',
    slug: 'dlom-methods',
    title: 'Choosing a DLOM method',
    category: 'Methodology',
    keywords: 'dlom chaffee finnerty',
    body_html: '<p>Chaffee vs Finnerty.</p>',
    sort_order: 20,
    published: false,
    updated_at: '2026-07-02T10:00:00Z',
  },
];

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

/** GET the list; every write is delegated to `onWrite` so a case can fail one. */
function mockApi(onWrite?: (path: string, init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      if (onWrite) return onWrite(path, init!);
      return jsonResponse({ ok: true });
    }
    if (path.includes('/help/articles')) return jsonResponse({ articles: ARTICLES });
    throw new Error(`unexpected fetch ${path}`);
  });
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminHelpPage />
    </MemoryRouter>,
  );

describe('AdminHelpPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists every article with its slug, category and publication state', async () => {
    mockApi();
    renderPage();

    const table = await screen.findByRole('table', { name: /help articles/i });
    expect(within(table).getByText('Getting started')).toBeInTheDocument();
    expect(within(table).getByText('/getting-started')).toBeInTheDocument();
    expect(within(table).getByText('Methodology')).toBeInTheDocument();
    // The draft is visibly a draft — an unpublished article is invisible to
    // readers, so the list is the only place that fact is legible.
    expect(within(table).getByText('Published')).toBeInTheDocument();
    expect(within(table).getByText('Draft')).toBeInTheDocument();
  });

  it('offers an empty state rather than a bare table when nothing is seeded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ articles: [] }));
    renderPage();
    await screen.findByText(/No articles yet/i);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('explains a 403 as an operations-only screen instead of a generic failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem(403, 'Forbidden'));
    renderPage();
    await screen.findByText(/operations-only/i);
    // The error replaces the spinner — a load that failed must not read as
    // one still in flight.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('falls back to a plain message on a non-403 load failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderPage();
    await screen.findByText(/Could not load the help articles/i);
  });

  it('creates an article by POST and reloads the list', async () => {
    const writes: Array<{ path: string; method: string; body: unknown }> = [];
    mockApi((path, init) => {
      writes.push({
        path,
        method: init.method ?? 'GET',
        body: JSON.parse(String(init.body)) as unknown,
      });
      return jsonResponse({ article: { id: 'new' } }, 201);
    });
    renderPage();
    await screen.findByRole('table', { name: /help articles/i });

    await userEvent.click(screen.getByRole('button', { name: /New article/i }));
    await userEvent.type(screen.getByLabelText('Title'), 'Waterfall basics');
    await userEvent.type(screen.getByLabelText(/^Slug/), 'waterfall-basics');
    await userEvent.click(screen.getByRole('button', { name: /Create article/i }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.method).toBe('POST');
    expect(writes[0]!.path).toContain('/admin/help/articles');
    expect(writes[0]!.body).toMatchObject({
      slug: 'waterfall-basics',
      title: 'Waterfall basics',
      // Untouched category defaults rather than posting an empty string.
      category: 'General',
      published: true,
    });
    // The editor closes on success.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Create article/i })).not.toBeInTheDocument(),
    );
  });

  it('PATCHes the existing id when editing rather than minting a second article', async () => {
    const writes: Array<{ path: string; method: string }> = [];
    mockApi((path, init) => {
      writes.push({ path, method: init.method ?? 'GET' });
      return jsonResponse({ ok: true });
    });
    renderPage();
    await screen.findByRole('table', { name: /help articles/i });

    const row = screen.getByText('Getting started').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));

    // The form is seeded from the row, not blank.
    expect(await screen.findByDisplayValue('Getting started')).toBeInTheDocument();
    expect(screen.getByDisplayValue('getting-started')).toBeInTheDocument();
    expect(screen.getByDisplayValue('intro onboarding first')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.method).toBe('PATCH');
    expect(writes[0]!.path).toContain(`/admin/help/articles/${ARTICLES[0]!.id}`);
  });

  it('keeps the editor open and shows the server message when a save fails', async () => {
    mockApi(() => problem(409, 'slug already taken'));
    renderPage();
    await screen.findByRole('table', { name: /help articles/i });

    const row = screen.getByText('Getting started').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await screen.findByText('slug already taken');
    // Losing the draft on a rejected save would make the analyst retype it.
    expect(screen.getByDisplayValue('Getting started')).toBeInTheDocument();
  });

  it('toggles publication with the inverse of the row it was clicked on', async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    mockApi((path, init) => {
      writes.push({ path, body: JSON.parse(String(init.body)) as unknown });
      return jsonResponse({ ok: true });
    });
    renderPage();
    await screen.findByRole('table', { name: /help articles/i });

    const draftRow = screen.getByText('Choosing a DLOM method').closest('tr')!;
    await userEvent.click(within(draftRow).getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.path).toContain(ARTICLES[1]!.id);
    expect(writes[0]!.body).toEqual({ published: true });
  });

  it('deletes only after the confirm is accepted', async () => {
    const writes: string[] = [];
    mockApi((path, init) => {
      writes.push(`${init.method} ${path}`);
      return jsonResponse({ ok: true });
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findByRole('table', { name: /help articles/i });

    const row = screen.getByText('Getting started').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalled();
    expect(writes).toHaveLength(0);

    confirm.mockReturnValue(true);
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!).toBe(`DELETE /api/v1/admin/help/articles/${ARTICLES[0]!.id}`);
  });

  it('surfaces a failed delete rather than leaving the row silently intact', async () => {
    mockApi(() => problem(409, 'article is referenced by a help link'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByRole('table', { name: /help articles/i });

    const row = screen.getByText('Getting started').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await screen.findByText('article is referenced by a help link');
  });

  it('blocks the submit until both the title and the slug carry content', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table', { name: /help articles/i });

    await userEvent.click(screen.getByRole('button', { name: /New article/i }));
    const submit = screen.getByRole('button', { name: /Create article/i });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Title'), 'Only a title');
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/^Slug/), 'only-a-title');
    expect(submit).toBeEnabled();
  });

  it('abandons the draft on cancel', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table', { name: /help articles/i });

    await userEvent.click(screen.getByRole('button', { name: /New article/i }));
    await userEvent.type(screen.getByLabelText('Title'), 'Scratch');
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  });

  it('coerces a non-numeric sort order to zero rather than posting NaN', async () => {
    const writes: Array<Record<string, unknown>> = [];
    mockApi((_path, init) => {
      writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse({ ok: true });
    });
    renderPage();
    await screen.findByRole('table', { name: /help articles/i });

    await userEvent.click(screen.getByRole('button', { name: /New article/i }));
    await userEvent.type(screen.getByLabelText('Title'), 'Ordering');
    await userEvent.type(screen.getByLabelText(/^Slug/), 'ordering');
    const sort = screen.getByLabelText(/Sort order/i);
    await userEvent.clear(sort);
    await userEvent.click(screen.getByRole('button', { name: /Create article/i }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.sort_order).toBe(0);
  });
});
