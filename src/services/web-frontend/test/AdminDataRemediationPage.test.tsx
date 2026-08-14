import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminDataRemediationPage } from '../src/pages/AdminDataRemediationPage';

const UNPUBLISHED = '01JREMEDIATIONUNPUB000001';
const PUBLISHED = '01JREMEDIATIONPUBBB000001';

const QUEUE = {
  stale_backsolves: {
    rows: [
      {
        calculation_id: 'calc-pub',
        valuation_id: PUBLISHED,
        valuation_number: 1802,
        company_name: 'Published Co',
        state: 'published',
        equity_value: '9000000',
        fmv_per_share: '0.9',
        options_outstanding: 900000,
        calculated_at: '2026-05-01T00:00:00Z',
        has_rendered_report: true,
        published: true,
      },
      {
        calculation_id: 'calc-unpub',
        valuation_id: UNPUBLISHED,
        valuation_number: 1811,
        company_name: 'Draft Co',
        state: 'review',
        equity_value: '4000000',
        fmv_per_share: '0.4',
        options_outstanding: 1500000,
        calculated_at: '2026-06-01T00:00:00Z',
        has_rendered_report: false,
        published: false,
      },
    ],
    total: 2,
    published: 1,
    rerunnable: 1,
    description: 'Calculations that took the single-breakpoint backsolve with a live option pool.',
  },
  stale_qa_reviews: {
    rows: [
      {
        review_id: 'rev-1',
        valuation_id: PUBLISHED,
        valuation_number: 1802,
        company_name: 'Published Co',
        state: 'published',
        dlom_method: 'chaffee',
        applied_dlom: '0.45',
        review_status: 'pass',
        reviewed_at: '2026-05-02T00:00:00Z',
        published: true,
      },
    ],
    total: 1,
    published: 1,
    description: 'QA reviews of a Chaffee/Finnerty run that carry no DLOM-range check.',
  },
  max_rerun: 25,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(onPost?: (init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if ((init?.method ?? 'GET') === 'POST' && onPost) return onPost(init!);
    return jsonResponse(QUEUE);
  });
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminDataRemediationPage />
    </MemoryRouter>,
  );

describe('AdminDataRemediationPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists both queues', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText(/#1811 Draft Co/)).toBeInTheDocument();
    expect(screen.getAllByText(/#1802 Published Co/).length).toBe(2);
  });

  /**
   * The whole point of the screen. A published 409A is a signed document a
   * client has relied on for a grant price or a tax position; re-running the
   * engine underneath it makes the platform disagree with a document already
   * out in the world.
   */
  it('will not let a published engagement be selected for re-run', async () => {
    mockApi();
    renderPage();
    const published = await screen.findByRole('checkbox', { name: /Published Co/i });
    expect(published).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Draft Co/i })).toBeEnabled();
  });

  it('sends only the selected unpublished engagements', async () => {
    let body: unknown;
    mockApi((init) => {
      body = JSON.parse(String(init.body));
      return jsonResponse({ succeeded: 1, failed: 0, results: [] });
    });
    renderPage();
    await screen.findByText(/#1811 Draft Co/);

    await userEvent.click(screen.getByRole('checkbox', { name: /Draft Co/i }));
    await userEvent.click(screen.getByRole('button', { name: /re-run 1 selected/i }));

    await waitFor(() => expect(body).toEqual({ valuation_ids: [UNPUBLISHED] }));
  });

  it('reports a partial failure with the reason', async () => {
    mockApi(() =>
      jsonResponse({ succeeded: 0, failed: 1, results: [{ error: 'params drifted out of range' }] }),
    );
    renderPage();
    await screen.findByText(/#1811 Draft Co/);
    await userEvent.click(screen.getByRole('checkbox', { name: /Draft Co/i }));
    await userEvent.click(screen.getByRole('button', { name: /re-run 1 selected/i }));

    expect(await screen.findByText(/params drifted out of range/)).toBeInTheDocument();
  });

  it('shows whether a report was actually rendered from the affected run', async () => {
    // The column that decides how much a row matters: an affected calculation
    // nobody rendered is a number in a table; one behind a PDF is a statement
    // made to a client.
    mockApi();
    renderPage();
    await screen.findByText(/#1811 Draft Co/);
    expect(screen.getByText('Report rendered')).toBeInTheDocument();
  });

  it('highlights a DLOM the missing check would have flagged', async () => {
    mockApi();
    renderPage();
    // 45% is over the 35% benchmark, and the check that would have said so
    // never ran on this review.
    expect(await screen.findByText('45.0%')).toBeInTheDocument();
  });

  it('explains an access refusal instead of showing empty queues', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 403 }, 403));
    renderPage();
    expect(await screen.findByText(/operations-only/i)).toBeInTheDocument();
  });

  /**
   * The queues are a page and the stat cards are the whole platform. With the
   * two disagreeing and nothing saying why, the shorter number reads as the
   * truth — which on a remediation queue means believing fewer engagements are
   * affected than are.
   */
  describe('a capped queue', () => {
    const truncated = {
      ...QUEUE,
      stale_backsolves: { ...QUEUE.stale_backsolves, total: 812, truncated: true, page_limit: 500 },
      stale_qa_reviews: { ...QUEUE.stale_qa_reviews, total: 96, truncated: true, page_limit: 500 },
    };

    it('says the table is a page and the totals are not', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(truncated));
      renderPage();
      expect(await screen.findByText(/Showing 2 of 812 affected calculations/)).toBeInTheDocument();
      expect(screen.getByText(/Showing 1 of 96 affected reviews/)).toBeInTheDocument();
    });

    it('still counts the whole queue on the cards, not the rows on screen', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(truncated));
      renderPage();
      // 812, not the 2 rows the page is showing.
      expect(await screen.findByText('812')).toBeInTheDocument();
    });

    it('says nothing when the page holds the whole queue', async () => {
      mockApi();
      renderPage();
      await screen.findByText(/#1811 Draft Co/);
      expect(screen.queryByText(/Showing \d+ of/)).not.toBeInTheDocument();
    });
  });
});
