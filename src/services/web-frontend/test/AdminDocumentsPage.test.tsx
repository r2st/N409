import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminDocumentsPage } from '../src/pages/AdminDocumentsPage';

/**
 * Legacy document triage (design §9.2).
 *
 * The page's whole reason to exist is that nothing is re-filed without a human
 * choosing, so the tests hold that line: a suggestion is shown with the term it
 * matched and selects nothing until it is clicked, and the action stays
 * disabled until a bucket is actually named.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const doc = (over: Record<string, unknown> = {}) => ({
  id: '01N409DOC00000000000000001',
  valuation_id: '01N409VA000000000000000001',
  valuation_number: 1766,
  company_name: 'Acme Corp',
  state: 'started',
  filename: 'Bylaws_Amended_2023.pdf',
  content_type: 'application/pdf',
  size_bytes: 240_000,
  uploaded_by_email: 'cfo@acme.test',
  created_at: '2026-02-01T09:00:00Z',
  suggestion: { category: 'corporate_documents', matched: 'bylaws' },
  ...over,
});

const CATEGORIES = [
  { key: 'corporate_documents', label: 'Corporate documents', description: '' },
  { key: 'stock_option_plan', label: 'Stock option plan', description: '' },
  { key: 'board_resolutions', label: 'Board resolutions', description: '' },
];

function mockApi(
  over: {
    documents?: unknown[];
    total?: number;
    truncated?: boolean;
    postStatus?: number;
    /** A per-row refusal for a row that stays in the queue (R422). */
    postResult?: unknown;
    /** Keep serving the same queue after the POST, as a failed file would. */
    keepQueue?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let round = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (method === 'POST') {
      bodies.push(JSON.parse(String(init!.body)));
      round += 1;
      const status = over.postStatus ?? 200;
      return jsonResponse(
        status >= 400
          ? { title: 'Forbidden', status }
          : (over.postResult ?? { succeeded: 1, failed: 0, results: [] }),
        status,
      );
    }
    // After a successful file the row is gone from the queue, as the server
    // would report it.
    const documents = round > 0 && !over.keepQueue ? [] : (over.documents ?? [doc()]);
    return jsonResponse({
      documents,
      total: over.total ?? documents.length,
      truncated: over.truncated ?? false,
      max_assign: 100,
      categories: CATEGORIES,
      suggested: documents.filter((d) => (d as { suggestion: unknown }).suggestion !== null).length,
    });
  });
  return { calls, bodies };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminDocumentsPage />
    </MemoryRouter>,
  );

describe('AdminDocumentsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists what is awaiting triage with the engagement it belongs to', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('Bylaws_Amended_2023.pdf')).toBeInTheDocument();
    expect(screen.getByText(/#1766 Acme Corp/)).toBeInTheDocument();
    expect(screen.getByText('cfo@acme.test')).toBeInTheDocument();
  });

  it('shows the term a suggestion matched on, not a confidence score', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText(/matched “bylaws”/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('selects nothing until a bucket is chosen', async () => {
    mockApi();
    renderPage();
    await screen.findByText('Bylaws_Amended_2023.pdf');
    // A suggestion is displayed and the dropdown still reads "leave it alone".
    expect(screen.getByLabelText(/File Bylaws_Amended_2023.pdf as/)).toHaveValue('');
    expect(screen.getByRole('button', { name: /^File 0 documents$/ })).toBeDisabled();
  });

  it('fills the dropdown when the suggestion is clicked, and only then', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await screen.findByText('Bylaws_Amended_2023.pdf');
    await user.click(screen.getByTitle(/Matched on “bylaws”/));
    expect(screen.getByLabelText(/File Bylaws_Amended_2023.pdf as/)).toHaveValue('corporate_documents');
    expect(screen.getByRole('button', { name: /^File 1 document$/ })).toBeEnabled();
  });

  it('posts the operator’s choice, not the suggestion', async () => {
    const user = userEvent.setup();
    const { bodies } = mockApi();
    renderPage();
    await screen.findByText('Bylaws_Amended_2023.pdf');
    // Overriding the suggestion is the case that matters — what is sent has to
    // be what the dropdown says.
    await user.selectOptions(screen.getByLabelText(/File Bylaws_Amended_2023.pdf as/), 'board_resolutions');
    await user.click(screen.getByRole('button', { name: /^File 1 document$/ }));
    await waitFor(() =>
      expect(bodies).toContainEqual({
        assignments: [{ document_id: '01N409DOC00000000000000001', category: 'board_resolutions' }],
      }),
    );
    expect(await screen.findByText(/Filed 1 document/)).toBeInTheDocument();
  });

  /**
   * R422, methodology M5 — a document that could not be filed keeps the bucket
   * the operator picked for it.
   *
   * The route answers per row and names each document it refused. `load` clears
   * every choice, which is right for the rows that were filed and wrong for the
   * rows that were not: a two-hundred-document batch that lost nine to a
   * transient write meant re-reading nine filenames and re-picking nine
   * categories, with nothing on the page saying which nine.
   */
  it('keeps the chosen bucket on a document that could not be filed', async () => {
    const user = userEvent.setup();
    const { bodies } = mockApi({
      keepQueue: true,
      postResult: {
        succeeded: 0,
        failed: 1,
        results: [
          {
            document_id: '01N409DOC00000000000000001',
            ok: false,
            error: 'Could not be re-filed — the reason is in the service log.',
          },
        ],
      },
    });
    renderPage();
    await screen.findByText('Bylaws_Amended_2023.pdf');
    await user.selectOptions(screen.getByLabelText(/File Bylaws_Amended_2023.pdf as/), 'board_resolutions');
    await user.click(screen.getByRole('button', { name: /^File 1 document$/ }));

    expect(await screen.findByText(/0 filed, 1 failed/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText(/File Bylaws_Amended_2023.pdf as/)).toHaveValue('board_resolutions'),
    );
    // …so Apply is armed for exactly that row again, without re-picking.
    await user.click(screen.getByRole('button', { name: /^File 1 document$/ }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({
      assignments: [{ document_id: '01N409DOC00000000000000001', category: 'board_resolutions' }],
    });
  });

  it('still clears the choice for a document that was filed', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await screen.findByText('Bylaws_Amended_2023.pdf');
    await user.selectOptions(screen.getByLabelText(/File Bylaws_Amended_2023.pdf as/), 'board_resolutions');
    await user.click(screen.getByRole('button', { name: /^File 1 document$/ }));

    expect(await screen.findByText(/Filed 1 document/)).toBeInTheDocument();
    // The row left the queue and took its choice with it — nothing is armed.
    await waitFor(() => expect(screen.getByText(/Nothing to triage/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^File 1 document$/ })).not.toBeInTheDocument();
  });

  it('accepts every suggestion in one action when asked', async () => {
    const user = userEvent.setup();
    const { bodies } = mockApi({
      documents: [
        doc(),
        doc({
          id: '01N409DOC00000000000000002',
          filename: 'Board Consent.pdf',
          suggestion: { category: 'board_resolutions', matched: 'board consent' },
        }),
        // No suggestion — must not be swept in with the rest.
        doc({ id: '01N409DOC00000000000000003', filename: 'scan_0012.pdf', suggestion: null }),
      ],
    });
    renderPage();
    await screen.findByText('scan_0012.pdf');
    await user.click(screen.getByRole('button', { name: /Fill in every suggestion/ }));
    await user.click(screen.getByRole('button', { name: /^File 2 documents$/ }));
    await waitFor(() =>
      expect(bodies).toContainEqual({
        assignments: [
          { document_id: '01N409DOC00000000000000001', category: 'corporate_documents' },
          { document_id: '01N409DOC00000000000000002', category: 'board_resolutions' },
        ],
      }),
    );
  });

  it('offers no shortcut when nothing has a suggestion', async () => {
    mockApi({ documents: [doc({ suggestion: null })] });
    renderPage();
    await screen.findByText('Bylaws_Amended_2023.pdf');
    expect(screen.queryByRole('button', { name: /Fill in every suggestion/ })).not.toBeInTheDocument();
  });

  it('says when the queue is longer than the page shows', async () => {
    mockApi({ documents: [doc()], total: 900, truncated: true });
    renderPage();
    expect(await screen.findByText(/Showing the 1 oldest of 900/)).toBeInTheDocument();
  });

  it('explains a forbidden queue rather than showing an empty one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ title: 'Forbidden', status: 403 }, 403));
    renderPage();
    expect(await screen.findByText(/operations-only/i)).toBeInTheDocument();
  });

  it('reports an empty queue as done rather than as broken', async () => {
    mockApi({ documents: [], total: 0 });
    renderPage();
    expect(await screen.findByText(/Nothing to triage/)).toBeInTheDocument();
  });
});
