import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { PaymentHistory } from '../src/components/PaymentSection';
import { SavedViews } from '../src/components/SavedViews';
import { SignaturePanel } from '../src/components/SignaturePanel';
import { FirmDashboardPage } from '../src/pages/FirmDashboardPage';
import { ValuationComparePage } from '../src/pages/ValuationComparePage';
import type { Valuation } from '../src/lib/types';

/**
 * Round 17 of the swallowed-load-error sweep, over the variant the spinner
 * check does not catch: a `catch` that assigns an empty list.
 *
 * The result renders past every guard, so the surface does not fail — it
 * answers. "No signatures on this valuation", "No clients yet", "You need at
 * least two valuations before there is anything to compare": each is a claim
 * about the account, made on the strength of a request that did not come back.
 * A user cannot tell one of these from the truth, and the two call for opposite
 * responses — retry, or go and do the thing that is missing.
 *
 * Six were found. Each is asserted here from the outside: what the user is
 * told, and what the surface must not offer them on the strength of it.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VALUATION = {
  id: '01TESTVALUATION0000000000A',
  kind: '409a',
  company_name: 'Acme Robotics, Inc.',
  currency: 'USD',
  state: 'draft_accepted',
  paid_status: 'paid',
} as Valuation;

/** Every request fails; the component under test decides what to say about it. */
const allFail = (status = 503) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(jsonResponse({ title: 'Service Unavailable', status }, status));

describe('a failed read must not be reported as an empty record', () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * The most consequential of the six. An empty signature list renders both
   * roles as "Not signed", stamps the engagement "Publish blocked — main
   * signature required", and re-offers the sign form — on a valuation that may
   * already carry both signatures. A failed read must not be able to produce a
   * duplicate signature, and must not tell an appraiser their signed report is
   * unsigned.
   */
  it('does not report an unread signature list as an unsigned valuation', async () => {
    allFail();
    render(<SignaturePanel valuation={VALUATION} />);

    expect(await screen.findByText('Could not load the signatures on this valuation.')).toBeInTheDocument();
    expect(screen.queryByText(/Publish blocked/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ready to publish/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not signed/)).not.toBeInTheDocument();
    // Nothing to sign with, because there is nothing to say what is signed.
    expect(screen.queryByRole('button', { name: /^sign$/i })).not.toBeInTheDocument();
  });

  it('waits before saying a valuation is unsigned', async () => {
    // The panel used to render "Publish blocked — main signature required"
    // during the load itself, so the badge flickered onto a signed engagement
    // every time the tab opened.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}) as Promise<Response>);
    render(<SignaturePanel valuation={VALUATION} />);

    expect(await screen.findByRole('status')).toHaveTextContent('Loading signatures');
    expect(screen.queryByText(/Publish blocked/)).not.toBeInTheDocument();
  });

  it('still reports the signatures once they arrive', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ signatures: [] }));
    render(<SignaturePanel valuation={VALUATION} />);

    // A genuinely empty list is still an answer, and reads exactly as before.
    expect(await screen.findByText(/Publish blocked — main signature required/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Not signed/i)).toHaveLength(2);
  });

  /**
   * The payment record hides itself when there is nothing to show, so a failed
   * read took the whole section off the page — and the reader most likely to
   * open it is someone checking whether a charge went through.
   */
  it('does not take the payment record off the page when it fails to load', async () => {
    allFail();
    render(<PaymentHistory valuation={VALUATION} />);

    expect(await screen.findByText('Could not load the payment history.')).toBeInTheDocument();
    expect(screen.getByText('Payment history')).toBeInTheDocument();
  });

  it('still hides itself when there genuinely are no payments', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ payments: [] }));
    const { container } = render(<PaymentHistory valuation={VALUATION} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  /**
   * A failed picker must not take the worklist with it — that part was right.
   * `setViews([])` went one step further and labelled the empty dropdown "No
   * saved views yet", which is a claim about the account rather than about the
   * request. The control stays (removing a real feature on a blip reads as it
   * having been taken away) and says what actually happened.
   */
  it('does not label an unread saved-view picker “No saved views yet”', async () => {
    allFail();
    render(
      <MemoryRouter>
        <AuthProvider>
          <SavedViews />
        </AuthProvider>
      </MemoryRouter>,
    );

    const picker = await screen.findByRole('combobox', { name: 'Saved view' });
    expect(picker).toHaveTextContent('Saved views unavailable');
    expect(picker).toBeDisabled();
    expect(screen.queryByText('No saved views yet')).not.toBeInTheDocument();
  });

  it('still says so when the user genuinely has no saved views', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ views: [] }));
    render(
      <MemoryRouter>
        <AuthProvider>
          <SavedViews />
        </AuthProvider>
      </MemoryRouter>,
    );

    const picker = await screen.findByRole('combobox', { name: 'Saved view' });
    expect(picker).toHaveTextContent('No saved views yet');
    expect(picker).toBeEnabled();
  });
});

describe('FirmDashboardPage — a book that failed to load is not an empty book', () => {
  beforeEach(() => vi.restoreAllMocks());

  const DASHBOARD = {
    firm: { id: '01N409FIRM0000000000000AA', name: 'Meridian Valuations' },
    summary: {
      total: 40,
      active: 12,
      published: 26,
      closed: 2,
      waiting_on_client: 3,
      overdue: 2,
      due_soon: 4,
      unassigned: 1,
      by_state: {},
    },
    team: [],
    attention: [],
    attention_total: 0,
    attention_counts: {
      overdue: 0,
      unassigned: 0,
      stalled_with_client: 0,
      stalled_in_review: 0,
      due_soon: 0,
    },
  };

  const renderPage = () =>
    render(
      <MemoryRouter>
        <FirmDashboardPage />
      </MemoryRouter>,
    );

  it('reports a client list that failed instead of showing “No clients yet”', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/firm/clients')) {
        return jsonResponse({ title: 'Bad Gateway', detail: 'The client index is rebuilding.' }, 502);
      }
      if (path.includes('/firm/dashboard')) return jsonResponse(DASHBOARD);
      if (path.includes('/firm/intake-links')) return jsonResponse({ links: [] });
      throw new Error(`unexpected fetch ${path}`);
    });
    renderPage();

    // The dashboard above it loaded fine — only the client list did not, and
    // only the client list says so.
    expect(await screen.findByText('Meridian Valuations')).toBeInTheDocument();
    expect(await screen.findByText('The client index is rebuilding.')).toBeInTheDocument();
    expect(screen.queryByText('No clients yet.')).not.toBeInTheDocument();
  });

  it('still says so when the firm genuinely has no clients', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/firm/clients')) return jsonResponse({ clients: [], total: 0 });
      if (path.includes('/firm/dashboard')) return jsonResponse(DASHBOARD);
      if (path.includes('/firm/intake-links')) return jsonResponse({ links: [] });
      throw new Error(`unexpected fetch ${path}`);
    });
    renderPage();

    expect(await screen.findByText('No clients yet.')).toBeInTheDocument();
  });
});

describe('ValuationComparePage — an unread list is not an account with one valuation', () => {
  beforeEach(() => vi.restoreAllMocks());

  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={['/compare']}>
        <ValuationComparePage />
      </MemoryRouter>,
    );

  it('reports a picker that failed to load rather than blaming the account', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/valuations?')) {
        return jsonResponse({ title: 'Service Unavailable', detail: 'The index is offline.' }, 503);
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderPage();

    expect(await screen.findByText('The index is offline.')).toBeInTheDocument();
    // "You need at least two valuations before there is anything to compare" is
    // a statement about the account. The account is not what failed.
    expect(
      screen.queryByText(/You need at least two valuations before there is anything to compare/),
    ).not.toBeInTheDocument();
  });

  it('still says so when the account really does have only one valuation', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/valuations?')) {
        return jsonResponse({
          valuations: [{ ...VALUATION, number: 1, created_at: '2026-01-01T00:00:00Z' }],
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderPage();

    expect(
      await screen.findByText(/You need at least two valuations before there is anything to compare/),
    ).toBeInTheDocument();
  });
});
