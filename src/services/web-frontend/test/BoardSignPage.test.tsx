import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardSignPage } from '../src/pages/BoardSignPage';
import { formatAmount } from '../src/lib/format';

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
    await user.click(await screen.findByRole('button', { name: 'Confirm signature' }));

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
    await user.click(await screen.findByRole('button', { name: 'Confirm signature' }));

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
    await user.click(await screen.findByRole('button', { name: 'Record rejection' }));

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
    await user.click(await screen.findByRole('button', { name: 'Confirm signature' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This resolution has already been superseded.',
    );
    // A failed write must leave the signer able to retry — and the error has to
    // be where they can read it, not behind the dialog that asked them.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign & adopt' })).toBeEnabled();
    expect(screen.getByText('Unanimous Written Consent')).toBeInTheDocument();
  });

  it('rejects a link with no token without calling the API, and says how to fix it', async () => {
    setHash('');
    const calls = mockApi({});
    render(<BoardSignPage />);

    const note = await screen.findByRole('alert');
    // The cause a director can act on, the remedy, and the fact they came for.
    expect(note).toHaveTextContent(/incomplete/i);
    expect(note).toHaveTextContent(/wrapped onto a second line/i);
    expect(note).toHaveTextContent(/no decision has been recorded for you/i);
    expect(calls).toHaveLength(0);
  });

  /**
   * The server writes one sentence per dead-link state on this surface
   * (`DEAD_LINK_DETAIL.board`) and this page used to translate the *status code*
   * back into six words of its own, discarding it. The three tests below are
   * the three statuses that reach the load path, and all of them assert the
   * server's own words survive to the alert.
   */
  it('shows the server’s dead-link sentence rather than restating the status', async () => {
    mockApi({
      resolution: () =>
        problem(
          404,
          'This signing link is no longer usable. It may have been cut short when it was copied — ' +
            'open the original email and use the whole link. Ask whoever circulated the resolution ' +
            'to send you a new signing link; no decision has been recorded for you.',
        ),
    });
    render(<BoardSignPage />);
    const note = await screen.findByRole('alert');
    expect(note).toHaveTextContent(/cut short when it was copied/i);
    expect(note).toHaveTextContent(/no decision has been recorded for you/i);
  });

  it('keeps the exact wait a throttled load was told to expect', async () => {
    // The public throttle computes the wait and phrases it; "could not load the
    // resolution" turned a 40-second wait into a dead end.
    mockApi({
      resolution: () =>
        problem(429, 'Too many requests to this signing link — try again in about 40 seconds.'),
    });
    render(<BoardSignPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('try again in about 40 seconds');
  });

  it('says a bodiless 5xx is the server’s problem, not the link’s', async () => {
    // A real 500 from this API carries no `detail` — the problem handler strips
    // it — so the page must not be reading one, and must not blame the link.
    mockApi({
      resolution: () =>
        new Response(
          JSON.stringify({ type: 'urn:n409:problem:internal', title: 'Internal Server Error', status: 500 }),
          {
            status: 500,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    });
    render(<BoardSignPage />);
    const note = await screen.findByRole('alert');
    expect(note).toHaveTextContent(/no explanation/i);
    expect(note).toHaveTextContent(/nothing was saved/i);
  });
});

/**
 * The confirmation between the click and the legal act.
 *
 * `POST /board/sign` refuses anything from a member who is not `pending`, and
 * the firm's remedy does not reach it: re-sending the link re-mints the token
 * and leaves the status alone, so the fresh link 409s on arrival. The only way
 * back is deleting the member and re-adding them. A director who meant Sign and
 * hit the button beside it had rejected their company's 409A resolution,
 * permanently, in one click.
 */
describe('BoardSignPage — confirming an irreversible decision', () => {
  /**
   * Whitespace normalised on both sides. A locale that puts a no-break space
   * between the figure and the currency symbol renders one the DOM keeps and a
   * plain `toHaveTextContent` string will not match.
   */
  const norm = (text: string | null) => (text ?? '').replace(/\s+/g, ' ');

  beforeEach(() => {
    vi.restoreAllMocks();
    setHash(`#token=${TOKEN}`);
  });
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('records nothing on the first click', async () => {
    const calls = mockApi({});
    const user = userEvent.setup();
    render(<BoardSignPage />);

    await user.click(await screen.findByRole('button', { name: 'Reject' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/board/sign'))).toBe(false);
  });

  it('lets the member back out with nothing recorded', async () => {
    const calls = mockApi({});
    const user = userEvent.setup();
    render(<BoardSignPage />);

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    await user.click(screen.getByRole('button', { name: 'Go back' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/board/sign'))).toBe(false);
    // And the resolution is still there to decide on.
    expect(screen.getByRole('button', { name: 'Sign & adopt' })).toBeEnabled();
    expect(screen.getByText('Unanimous Written Consent')).toBeInTheDocument();
  });

  /**
   * The figure and the date were on the wire the whole time — `fmv_conclusion`,
   * `currency` and `valuation_date` were in the payload and read by nothing.
   * The prose carries them too, inside a box that scrolls; the confirmation is
   * where they are unmissable.
   */
  it('names what is being adopted, in money and as of when', async () => {
    mockApi({});
    const user = userEvent.setup();
    render(<BoardSignPage />);

    await user.click(await screen.findByRole('button', { name: 'Sign & adopt' }));

    const dialog = screen.getByRole('dialog');
    // Built through the formatter rather than written out: the literal `$1.42`
    // is an assertion about the machine's locale, and the same figure reads
    // `1,42 $` under a German one — with a no-break space in it, which is why
    // both sides go through `norm`. The guard is that it is not the
    // unreadable-amount placeholder, so the check cannot pass vacuously.
    const money = formatAmount('1.4200', 'USD');
    expect(money).not.toBe('—');
    expect(norm(dialog.textContent)).toContain(`${norm(money)} per share`);
    expect(dialog).toHaveTextContent(/as of .*2026/);
    expect(dialog).toHaveTextContent('cannot be changed afterwards');
    // Recorded against a named person, which is what makes it a signature.
    expect(dialog).toHaveTextContent('Dana Director');
    expect(dialog).toHaveTextContent('dana@board.example');
  });

  /** A sub-dollar common-share price is the ordinary case for a 409A. */
  it('does not round a fraction-of-a-cent share price away', async () => {
    mockApi({
      resolution: () =>
        jsonResponse({
          ...RESOLUTION,
          resolution: { ...RESOLUTION.resolution, fmv_conclusion: '0.0001' },
        }),
    });
    const user = userEvent.setup();
    render(<BoardSignPage />);

    await user.click(await screen.findByRole('button', { name: 'Sign & adopt' }));

    const money = formatAmount('0.0001', 'USD');
    expect(money).toMatch(/0[.,]0001/);
    expect(norm(screen.getByRole('dialog').textContent)).toContain(`${norm(money)} per share`);
  });

  it('shows the comment that will be recorded alongside the decision', async () => {
    mockApi({});
    const user = userEvent.setup();
    render(<BoardSignPage />);

    await user.type(await screen.findByLabelText('Comment (optional)'), 'Abstaining on process grounds.');
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('Abstaining on process grounds.');
  });

  it('asks a different question for each decision', async () => {
    mockApi({});
    const user = userEvent.setup();
    render(<BoardSignPage />);

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Reject this resolution?');
    await user.click(screen.getByRole('button', { name: 'Go back' }));

    await user.click(screen.getByRole('button', { name: 'Sign & adopt' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Sign this resolution?');
  });

  /** Said before the click too, not only after it. */
  it('warns on the page itself that a decision is final', async () => {
    mockApi({});
    render(<BoardSignPage />);

    expect(await screen.findByText(/recorded against your name and cannot be changed/i)).toBeInTheDocument();
  });
});
