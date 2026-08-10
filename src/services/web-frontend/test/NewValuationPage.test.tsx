import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { NewValuationPage } from '../src/pages/NewValuationPage';
import { COMPANY_HINT_KEY } from '../src/pages/RegisterPage';
import { VALUATION_KINDS } from '../src/lib/types';

/**
 * The first screen of a paid engagement. Two things have to hold: the kind the
 * founder picked is the kind that gets created, and the company name they typed
 * during registration is not asked for a second time.
 */

const NEW_ID = '01N409VALNEW000000000000AA';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

function mockApi(respond?: (body: unknown) => Response) {
  const posts: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    posts.push({ url: String(url), body });
    return respond ? respond(body) : jsonResponse({ valuation: { id: NEW_ID } });
  });
  return posts;
}

/** Stands in for the workspace a successful create navigates to. */
function Landed() {
  const { id } = useParams();
  return <div data-testid="landed">{id}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/valuations/new']}>
      <Routes>
        <Route path="/valuations/new" element={<NewValuationPage />} />
        <Route path="/valuations/:id" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NewValuationPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates the valuation and lands on its workspace', async () => {
    const posts = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Company legal name'), 'Acme, Inc.');
    await user.click(screen.getByRole('button', { name: 'Create valuation' }));

    await waitFor(() => expect(screen.getByTestId('landed')).toHaveTextContent(NEW_ID));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('/api/v1/valuations');
    expect(posts[0]!.body).toEqual({ kind: '409a', company_name: 'Acme, Inc.', currency: 'USD' });
  });

  it('creates the kind the founder selected, not the default', async () => {
    const posts = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: /QSBS/ }));
    await user.type(screen.getByLabelText('Company legal name'), 'Acme, Inc.');
    await user.click(screen.getByRole('button', { name: 'Create valuation' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0]!.body as { kind: string }).kind).toBe('qsbs');
  });

  it('marks the chosen kind as pressed and unpresses the previous one', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();

    const defaultCard = screen.getByRole('button', { name: /IRC §409A/ });
    expect(defaultCard).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /ASC 718/ }));
    expect(screen.getByRole('button', { name: /ASC 718/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /IRC §409A/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows only the featured kinds until asked for the rest', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();

    expect(screen.queryByRole('button', { name: /IFRS 2/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: `Show all ${VALUATION_KINDS.length} valuation types →` }));

    expect(screen.getByRole('button', { name: /IFRS 2/ })).toBeInTheDocument();
    // The disclosure retires itself once everything is on screen.
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  it('prefills the company name captured at registration and clears the hint on success', async () => {
    localStorage.setItem(COMPANY_HINT_KEY, 'Hinted Holdings');
    mockApi();
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByLabelText('Company legal name')).toHaveValue('Hinted Holdings');

    await user.click(screen.getByRole('button', { name: 'Create valuation' }));
    await waitFor(() => expect(screen.getByTestId('landed')).toBeInTheDocument());
    // Leaving the hint behind would prefill every later valuation with the
    // company the founder registered with.
    expect(localStorage.getItem(COMPANY_HINT_KEY)).toBeNull();
  });

  it('refuses to submit without a company name or a three-letter currency', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();

    const submit = screen.getByRole('button', { name: 'Create valuation' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Company legal name'), '   ');
    expect(submit).toBeDisabled();

    await user.clear(screen.getByLabelText('Company legal name'));
    await user.type(screen.getByLabelText('Company legal name'), 'Acme');
    expect(submit).toBeEnabled();

    await user.clear(screen.getByLabelText(/Currency/));
    await user.type(screen.getByLabelText(/Currency/), 'US');
    expect(submit).toBeDisabled();
  });

  it('normalises a lowercase currency to its ISO 4217 form', async () => {
    const posts = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Company legal name'), '  Acme, Inc.  ');
    await user.clear(screen.getByLabelText(/Currency/));
    await user.type(screen.getByLabelText(/Currency/), 'gbp');
    await user.click(screen.getByRole('button', { name: 'Create valuation' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ kind: '409a', company_name: 'Acme, Inc.', currency: 'GBP' });
  });

  it('surfaces the server’s reason for a rejected create and stays on the form', async () => {
    mockApi(() => problem(409, 'A valuation for this company is already in flight.'));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Company legal name'), 'Acme, Inc.');
    await user.click(screen.getByRole('button', { name: 'Create valuation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A valuation for this company is already in flight.',
    );
    expect(screen.queryByTestId('landed')).not.toBeInTheDocument();
    // The button has to come back, or a transient failure strands the founder.
    expect(screen.getByRole('button', { name: 'Create valuation' })).toBeEnabled();
  });

  it('falls back to a generic message when the failure is not an API problem', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Company legal name'), 'Acme, Inc.');
    await user.click(screen.getByRole('button', { name: 'Create valuation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create the valuation.');
  });
});
