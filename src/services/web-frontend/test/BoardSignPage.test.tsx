import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardSignPage } from '../src/pages/BoardSignPage';

/**
 * The one screen an outsider reaches. The signing token is a bearer credential
 * carried in the URL fragment, the resolution body is server HTML rendered into
 * the page, and the outcome is a legal act — so the tests here are about where
 * the token goes, what gets rendered, and that a decision is recorded once.
 */

const TOKEN = 'bt_01N409BOARDTOKEN0000000000';

const RESOLUTION = {
  member: { name: 'Dana Director', email: 'dana@board.example', status: 'pending' as const },
  resolution: {
    body_html: '<h1>Unanimous Written Consent</h1><p>The Board adopts the valuation.</p>',
    status: 'sent',
    valuation_date: '2026-06-30',
    fmv_conclusion: '1.4200',
    currency: 'USD',
  },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function mockApi(handlers: { resolution?: () => Response; sign?: () => Response }): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    calls.push({
      url: path,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (path.includes('/board/sign')) return handlers.sign?.() ?? jsonResponse({ ok: true });
    return handlers.resolution?.() ?? jsonResponse(RESOLUTION);
  });
  return calls;
}

function setHash(hash: string) {
  window.history.replaceState(null, '', `/board-sign${hash}`);
}

describe('BoardSignPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setHash(`#token=${TOKEN}`);
  });
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('sends the signing token in the request body, never in the query string', async () => {
    const calls = mockApi({});
    render(<BoardSignPage />);

    await screen.findByText(/Dana Director/);
    const load = calls[0]!;
    expect(load.method).toBe('POST');
    expect(load.url).toBe('/api/v1/board/resolution');
    expect(load.url).not.toContain(TOKEN);
    expect(load.body).toEqual({ token: TOKEN });
  });

  it('renders the resolution body and identifies who is signing', async () => {
    mockApi({});
    render(<BoardSignPage />);

    expect(await screen.findByText('Unanimous Written Consent')).toBeInTheDocument();
    expect(screen.getByText('The Board adopts the valuation.')).toBeInTheDocument();
    expect(screen.getByText('Dana Director')).toBeInTheDocument();
    expect(screen.getByText(/dana@board\.example/)).toBeInTheDocument();
  });

  it('strips script from the resolution HTML before it reaches an outsider’s browser', async () => {
    mockApi({
      resolution: () =>
        jsonResponse({
          ...RESOLUTION,
          resolution: {
            ...RESOLUTION.resolution,
            body_html:
              '<p>Adopted.</p><script>window.__pwned = 1</script><img src=x onerror="window.__pwned=2">',
          },
        }),
    });
    render(<BoardSignPage />);

    await screen.findByText('Adopted.');
    const html = document.querySelector('.prose-resolution')!.innerHTML;
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
  });

  it('records a signature with the optional comment and thanks the signer', async () => {
    const calls = mockApi({});
    const user = userEvent.setup();
    render(<BoardSignPage />);

    await user.type(await screen.findByLabelText('Comment (optional)'), 'Adopted as presented.');
    await user.click(screen.getByRole('button', { name: 'Sign & adopt' }));

    await waitFor(() => expect(screen.getByText(/your signature is recorded/i)).toBeInTheDocument());
    const sign = calls.find((c) => c.url.includes('/board/sign'))!;
    expect(sign.body).toEqual({ token: TOKEN, decision: 'signed', comment: 'Adopted as presented.' });
    // Signed is terminal — the buttons must not invite a second submission.
    expect(screen.queryByRole('button', { name: 'Sign & adopt' })).not.toBeInTheDocument();
  });

  it('sends a null comment rather than an empty string when none was written', async () => {
    const calls = mockApi({});
    const user = userEvent.setup();
    render(<BoardSignPage />);

    await user.click(await screen.findByRole('button', { name: 'Sign & adopt' }));

    await waitFor(() => expect(calls.some((c) => c.url.includes('/board/sign'))).toBe(true));
    expect(calls.find((c) => c.url.includes('/board/sign'))!.body).toEqual({
      token: TOKEN,
      decision: 'signed',
      comment: null,
    });
  });

  it('records a rejection distinctly from a signature', async () => {
    const calls = mockApi({});
    const user = userEvent.setup();
    render(<BoardSignPage />);

    await user.click(await screen.findByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(screen.getByText('Your response is recorded.')).toBeInTheDocument());
    expect(screen.queryByText(/your signature is recorded/i)).not.toBeInTheDocument();
    expect(calls.find((c) => c.url.includes('/board/sign'))!.body).toMatchObject({
      decision: 'rejected',
    });
  });

  it('shows the recorded outcome instead of the form to a member who already signed', async () => {
    mockApi({
      resolution: () => jsonResponse({ ...RESOLUTION, member: { ...RESOLUTION.member, status: 'signed' } }),
    });
    render(<BoardSignPage />);

    expect(await screen.findByText(/your signature is recorded/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign & adopt' })).not.toBeInTheDocument();
  });

  it('keeps the resolution on screen and explains a failed submission', async () => {
    mockApi({ sign: () => problem(409, 'This resolution has already been superseded.') });
    const user = userEvent.setup();
    render(<BoardSignPage />);

    await user.click(await screen.findByRole('button', { name: 'Sign & adopt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This resolution has already been superseded.',
    );
    // A failed write must leave the signer able to retry.
    expect(screen.getByRole('button', { name: 'Sign & adopt' })).toBeEnabled();
    expect(screen.getByText('Unanimous Written Consent')).toBeInTheDocument();
  });

  it('rejects a link with no token without calling the API', async () => {
    setHash('');
    const calls = mockApi({});
    render(<BoardSignPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('This signing link is invalid or incomplete.');
    expect(calls).toHaveLength(0);
  });

  it('distinguishes an expired link from a server problem', async () => {
    mockApi({ resolution: () => problem(404, 'not found') });
    render(<BoardSignPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This signing link is no longer valid.');
  });

  it('reports a load failure that is not a 404 generically', async () => {
    mockApi({ resolution: () => problem(500, 'boom') });
    render(<BoardSignPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the resolution.');
  });
});
