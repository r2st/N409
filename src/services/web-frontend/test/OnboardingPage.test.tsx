import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { OnboardingPage } from '../src/pages/OnboardingPage';
import { ONBOARDING_DRAFT_KEY } from '../src/lib/onboardingDraft';
import { OFFLINE_DETAIL } from '../src/lib/api';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VALUATION = {
  id: '01TESTVALUATION0000000000A',
  kind: '409a',
  company_name: 'Acme Robotics, Inc.',
  currency: 'USD',
  state: 'pending',
  paid_status: 'unpaid',
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OnboardingPage (guided client funnel)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('walks company → payment → uploads → done, skipping payment when Stripe is unconfigured', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/valuations') && init?.method === 'POST') {
        return jsonResponse({ valuation: VALUATION }, 201);
      }
      if (url.includes('/payments/quote')) {
        return jsonResponse({
          quote: { amount_cents: 119_000, currency: 'USD', kind: '409a', configured: false },
        });
      }
      if (url.includes('/payments/checkout')) {
        return jsonResponse(
          {
            type: 'urn:n409:problem:payments-unconfigured',
            status: 503,
            title: 'Service Unavailable',
            detail: 'Payments are not configured (STRIPE_SECRET_KEY unset)',
          },
          503,
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderPage();

    // Step 1 — company details
    expect(screen.getByText("Let's get your valuation started")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme Robotics, Inc.');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Step 2 — payment, with the exact list price shown before checkout
    await waitFor(() => expect(screen.getByRole('button', { name: /with card/i })).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/valuations'),
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => expect(screen.getByTestId('onboarding-quote')).toHaveTextContent('$1,190.00'));

    // Stripe unconfigured → 503 → invoice fallback advances to uploads
    await user.click(screen.getByRole('button', { name: /with card/i }));
    await waitFor(() => expect(screen.getByText(/online payment is not available yet/i)).toBeInTheDocument());
    expect(screen.getByText(/upload what you have/i)).toBeInTheDocument();

    // Step 3 → skip uploads → done
    await user.click(screen.getByRole('button', { name: /skip uploads for now/i }));
    expect(screen.getByText(/your request is in/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open my valuation/i })).toBeInTheDocument();
  });

  /**
   * A 503 is not one situation, and this branch does more than print a
   * sentence: it advances the client past payment and writes the note into the
   * remembered draft. A maintenance window or a busy database was therefore
   * leaving a signed-up client parked on the uploads step believing an invoice
   * was coming, with the belief persisted across a reload.
   */
  it.each([
    [
      'a maintenance window',
      {
        type: 'urn:n409:problem:unavailable',
        status: 503,
        title: 'Service Unavailable',
        detail: 'The platform is in maintenance mode — changes are temporarily disabled.',
      },
      /maintenance mode/i,
    ],
    [
      'a busy database',
      {
        type: 'urn:n409:problem:database-unavailable',
        status: 503,
        title: 'Service Unavailable',
        detail: 'The database is temporarily unable to serve this request. Nothing was changed.',
      },
      /nothing was changed/i,
    ],
  ])('does not skip payment, or promise an invoice, for %s', async (_name, problem, expected) => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/valuations') && init?.method === 'POST') {
        return jsonResponse({ valuation: VALUATION }, 201);
      }
      if (url.includes('/payments/quote')) {
        return jsonResponse({
          quote: { amount_cents: 119_000, currency: 'USD', kind: '409a', configured: true },
        });
      }
      if (url.includes('/payments/checkout')) return jsonResponse(problem, 503);
      throw new Error(`unexpected fetch ${url}`);
    });

    renderPage();
    await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme Robotics, Inc.');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /with card/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /with card/i }));

    // The server's own reason, on the payment step the client is still on.
    await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
    expect(screen.queryByText(/we will send an invoice instead/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /with card/i })).toBeInTheDocument();
    // And nothing about an invoice was written into the resumable draft.
    expect(JSON.stringify(sessionStorage)).not.toMatch(/invoice/i);
  });

  it('lets the client skip payment explicitly', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/valuations') && init?.method === 'POST') {
        return jsonResponse({ valuation: VALUATION }, 201);
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderPage();
    await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => screen.getByRole('button', { name: /skip for now/i }));
    await user.click(screen.getByRole('button', { name: /skip for now/i }));
    expect(screen.getByText(/upload what you have/i)).toBeInTheDocument();
    // The engagement checklist is shown (kinds also appear in the type picker).
    expect(screen.getAllByText(/articles of incorporation/i).length).toBeGreaterThan(0);
  });

  /**
   * The Stripe step leaves the page. Everything below is about what the client
   * finds when they come back — the failure being prevented is a second
   * valuation created because the first was forgotten.
   */
  describe('progress persistence', () => {
    const stubQuote = () =>
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/valuations') && init?.method === 'POST') {
          return jsonResponse({ valuation: VALUATION }, 201);
        }
        if (url.includes('/payments/quote')) {
          return jsonResponse({
            quote: { amount_cents: 119_000, currency: 'USD', kind: '409a', configured: true },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      });

    it('resumes the same request after a remount instead of asking for the company again', async () => {
      const user = userEvent.setup();
      stubQuote();

      const first = renderPage();
      await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme Robotics, Inc.');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /with card/i })).toBeInTheDocument());
      first.unmount();

      // A refresh, a restored tab, or the return leg of the Stripe redirect.
      renderPage();
      expect(screen.getByTestId('onboarding-resumed')).toHaveTextContent('Acme Robotics, Inc.');
      expect(screen.getByRole('button', { name: /with card/i })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Acme Robotics, Inc.')).not.toBeInTheDocument();
    });

    it('offers a way out of a resumed request, and starts genuinely clean', async () => {
      /*
       * Resuming is right nine times out of ten. The tenth is a client who
       * abandoned a request — a cancelled checkout, a wrong company name, a
       * change of mind — and came back to start a different one, and there was
       * no control anywhere on the page to do it: the draft outlives the visit
       * inside the tab session, the wizard has no Back, and the only exit was
       * to walk the abandoned request forward to its congratulations screen and
       * press "Open my valuation" for a company they did not want.
       *
       * Someone in that position types the new name over the old one at the
       * first box they can reach, which produces a second engagement for one
       * client — the exact duplicate the draft was added to prevent.
       */
      const user = userEvent.setup();
      stubQuote();

      const first = renderPage();
      await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme Robotics, Inc.');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /with card/i })).toBeInTheDocument());
      first.unmount();

      renderPage();
      expect(screen.getByTestId('onboarding-resumed')).toHaveTextContent('Acme Robotics, Inc.');
      await user.click(screen.getByRole('button', { name: /start a different request/i }));

      // Back at step 1 with an empty box — not the old company name sitting in
      // a field that now writes to a different engagement.
      const box = screen.getByPlaceholderText('Acme Robotics, Inc.');
      expect(box).toHaveValue('');
      expect(screen.queryByTestId('onboarding-resumed')).toBeNull();

      // And it says what became of the request they walked away from. Silently
      // dropping it reads as having cancelled it, which is the one thing this
      // button must not be mistaken for — the engagement exists server-side.
      const note = screen.getByTestId('onboarding-discarded');
      expect(note).toHaveTextContent('Acme Robotics, Inc.');
      expect(note).toHaveTextContent(/has not been cancelled/i);
      expect(within(note).getByRole('link', { name: /your valuations/i })).toHaveAttribute(
        'href',
        '/valuations',
      );

      // The draft is gone from storage too, so a remount does not resurrect it.
      expect(sessionStorage.getItem(ONBOARDING_DRAFT_KEY)).toBeNull();
    });

    it('parks on the uploads step before handing the browser to Stripe', async () => {
      const user = userEvent.setup();
      const assign = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({
        ...window.location,
        assign,
      } as unknown as Location);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/valuations') && init?.method === 'POST') {
          return jsonResponse({ valuation: VALUATION }, 201);
        }
        if (url.includes('/payments/quote')) {
          return jsonResponse({ quote: { amount_cents: 119_000, currency: 'USD', kind: '409a' } });
        }
        if (url.includes('/payments/checkout')) {
          return jsonResponse({ checkout_url: 'https://checkout.stripe.test/session' });
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const first = renderPage();
      await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await waitFor(() => screen.getByRole('button', { name: /with card/i }));
      await user.click(screen.getByRole('button', { name: /with card/i }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/session'));
      first.unmount();

      // Coming back — paid or cancelled — lands on uploads, not on step one.
      renderPage();
      expect(screen.getByText(/upload what you have/i)).toBeInTheDocument();
      expect(screen.getByTestId('onboarding-resumed')).toBeInTheDocument();
    });

    it('re-fetches the price on resume rather than showing a cached one', async () => {
      const user = userEvent.setup();
      const fetchMock = stubQuote();

      const first = renderPage();
      await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await waitFor(() => expect(screen.getByTestId('onboarding-quote')).toHaveTextContent('$1,190.00'));
      first.unmount();

      fetchMock.mockImplementation(async (input) => {
        if (String(input).includes('/payments/quote')) {
          return jsonResponse({
            quote: { amount_cents: 129_000, currency: 'USD', kind: '409a', configured: true },
          });
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      });
      renderPage();
      await waitFor(() => expect(screen.getByTestId('onboarding-quote')).toHaveTextContent('$1,290.00'));
    });

    it('forgets the request once the client leaves the finished funnel', async () => {
      const user = userEvent.setup();
      stubQuote();

      const first = renderPage();
      await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await waitFor(() => screen.getByRole('button', { name: /skip for now/i }));
      await user.click(screen.getByRole('button', { name: /skip for now/i }));
      await user.click(screen.getByRole('button', { name: /skip uploads for now/i }));
      expect(screen.getByText(/your request is in/i)).toBeInTheDocument();

      // Still resumable while they are looking at the confirmation…
      first.unmount();
      renderPage();
      expect(screen.getByText(/your request is in/i)).toBeInTheDocument();

      // …and gone once they leave it.
      await user.click(screen.getByRole('button', { name: /open my valuation/i }));
      renderPage();
      expect(screen.getByPlaceholderText('Acme Robotics, Inc.')).toBeInTheDocument();
      expect(screen.queryByTestId('onboarding-resumed')).not.toBeInTheDocument();
    });

    it('starts clean rather than breaking when the stored draft is junk', () => {
      sessionStorage.setItem('n409.onboarding.draft', '{"version":1,"step":9,"valuation":null}');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ valuations: [] }));
      renderPage();
      expect(screen.getByPlaceholderText('Acme Robotics, Inc.')).toBeInTheDocument();
      expect(screen.queryByTestId('onboarding-resumed')).not.toBeInTheDocument();
    });
  });

  it('surfaces creation errors instead of advancing', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ detail: 'Not allowed to create valuations' }, 403),
    );

    renderPage();
    await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText(/not allowed to create valuations/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /pay now/i })).not.toBeInTheDocument();
  });

  /**
   * R31 — the first screen of the funnel is the worst place to hand someone a
   * server 422, and the person filling it in is a client rather than an analyst
   * who knows what the boxes want. The rules are the ones the ops-side
   * new-valuation form already carries, because it is the same POST.
   */
  describe('validation', () => {
    it('names the empty company box instead of disabling the button', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
      renderPage();

      const submit = screen.getByRole('button', { name: /continue/i });
      expect(submit).toBeEnabled();
      await user.click(submit);

      expect(await screen.findByText('Company legal name is required.')).toBeInTheDocument();
      expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')).toBeUndefined();
    });

    it('refuses a currency that is not a three-letter code', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
      renderPage();

      await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme Robotics, Inc.');
      await user.clear(screen.getByLabelText('Currency'));
      await user.type(screen.getByLabelText('Currency'), 'US');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      expect(
        await screen.findByText('Currency must be a three-letter ISO 4217 code, like USD.'),
      ).toBeInTheDocument();
      expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')).toBeUndefined();
    });

    it('refuses a blank currency rather than quietly substituting USD', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
      renderPage();

      await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme Robotics, Inc.');
      await user.clear(screen.getByLabelText('Currency'));
      await user.click(screen.getByRole('button', { name: /continue/i }));

      expect(await screen.findByText('Currency is required.')).toBeInTheDocument();
      expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')).toBeUndefined();
    });

    /** Lower case is accepted and upper-cased on the way out, as before. */
    it('upper-cases an accepted currency on the way to the API', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/valuations') && init?.method === 'POST')
          return jsonResponse({ valuation: VALUATION }, 201);
        return jsonResponse({ quote: { amount_cents: 1000, currency: 'GBP', kind: '409a' } });
      });
      renderPage();

      await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme Robotics, Inc.');
      await user.clear(screen.getByLabelText('Currency'));
      await user.type(screen.getByLabelText('Currency'), 'gbp');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
        expect(post).toBeTruthy();
        expect(JSON.parse(String(post![1]!.body)).currency).toBe('GBP');
      });
    });

    /**
     * The message waits for the box to be left once: telling a client their
     * company name is required while they are typing the "A" of "Acme" is the
     * failure mode this rule exists to avoid.
     */
    it('holds the message back until the box is blurred', async () => {
      const user = userEvent.setup();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
      renderPage();

      const company = screen.getByPlaceholderText('Acme Robotics, Inc.');
      await user.type(company, 'A');
      await user.clear(company);
      expect(screen.queryByText('Company legal name is required.')).not.toBeInTheDocument();

      await user.tab();
      expect(await screen.findByText('Company legal name is required.')).toBeInTheDocument();
    });
  });
});

/**
 * Step 3 — the document uploads. Reached by resuming a draft, which is how a
 * client returning from the Stripe round trip gets here too.
 */
describe('OnboardingPage — uploading documents', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  /** Land straight on the upload step with a valuation already created. */
  function resumeAtUploads(uploaded: Record<string, string[]> = {}) {
    sessionStorage.setItem(
      'n409.onboarding.draft',
      JSON.stringify({
        version: 1,
        step: 2,
        valuation: VALUATION,
        uploaded,
        savedAt: Date.now(),
      }),
    );
    renderPage();
  }

  const file = (name: string) => new File(['x'], name, { type: 'application/pdf' });
  const picker = () => document.querySelector('input[type="file"]') as HTMLInputElement;
  const storedUploads = () => JSON.parse(sessionStorage.getItem('n409.onboarding.draft') ?? '{}').uploaded;

  it('uploads the chosen files and ticks the checklist', async () => {
    const user = userEvent.setup();
    const sent: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/documents')) {
        sent.push(String((init?.body as FormData).get('kind')));
        return jsonResponse({ document: { id: 'd1' } }, 201);
      }
      return jsonResponse({});
    });
    resumeAtUploads();

    await user.upload(picker(), [file('cap.pdf'), file('table.pdf')]);

    // The tick carries the count, so both files have to be recorded.
    await waitFor(() => expect(screen.getByText('(2)')).toBeInTheDocument());
    expect(sent).toEqual(['cap_table', 'cap_table']);
    expect(storedUploads()).toEqual({ cap_table: ['cap.pdf', 'table.pdf'] });
  });

  it('files the upload under the document type that was chosen', async () => {
    const user = userEvent.setup();
    let kind: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/documents')) {
        kind = String((init?.body as FormData).get('kind'));
        return jsonResponse({ document: { id: 'd1' } }, 201);
      }
      return jsonResponse({});
    });
    resumeAtUploads();

    await user.selectOptions(screen.getByLabelText('Document type'), 'balance_sheet');
    await user.upload(picker(), file('bs.pdf'));

    await waitFor(() => expect(kind).toBe('balance_sheet'));
    await waitFor(() => expect(storedUploads()).toEqual({ balance_sheet: ['bs.pdf'] }));
  });

  /**
   * The bug: the ticks were written only after the whole loop had run, so a
   * failure partway through discarded the names of the files already sitting on
   * the server. The client resumed the wizard, saw no tick against the cap
   * table, and uploaded it a second time — the one thing the ticks are for.
   */
  it('keeps the files that landed when a later one fails', async () => {
    const user = userEvent.setup();
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/documents')) {
        n += 1;
        if (n === 3) return jsonResponse({ detail: 'That file is too large.' }, 413);
        return jsonResponse({ document: { id: `d${n}` } }, 201);
      }
      return jsonResponse({});
    });
    resumeAtUploads();

    await user.upload(picker(), [file('one.pdf'), file('two.pdf'), file('three.pdf')]);

    expect(await screen.findByText('That file is too large.')).toBeInTheDocument();
    // The two that made it are on the server, so they are ticked and recorded —
    // and the one that did not is neither.
    await waitFor(() => expect(screen.getByText('(2)')).toBeInTheDocument());
    expect(storedUploads()).toEqual({ cap_table: ['one.pdf', 'two.pdf'] });
  });

  /**
   * R421, methodology M6. Two screens post to `POST /valuations/:id/documents`
   * and they disagreed about what could be sent: the documents panel refuses an
   * oversized file in the browser, this one had no local check at all — so the
   * client least likely to be on a fast uplink was the one who pushed 30 MB
   * before hearing no.
   */
  it('refuses an oversized file without sending it, and uploads the rest', async () => {
    const user = userEvent.setup();
    const posted: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/documents')) {
        const form = (init as { body?: FormData } | undefined)?.body;
        posted.push((form?.get('file') as File).name);
        return jsonResponse({ document: { id: 'd1' } }, 201);
      }
      return jsonResponse({});
    });
    resumeAtUploads();

    const huge = new File([new Uint8Array(26 * 1024 * 1024)], 'scan.pdf', { type: 'application/pdf' });
    await user.upload(picker(), [huge, file('ok.pdf')]);

    expect(await screen.findByText(/scan\.pdf/)).toBeInTheDocument();
    // Never sent, and the file after it was not skipped with it.
    expect(posted).toEqual(['ok.pdf']);
    expect(storedUploads()).toEqual({ cap_table: ['ok.pdf'] });
  });

  /**
   * The other half: a failure part-way used to `throw` out of the whole loop,
   * so every file after it was never attempted and the client was told nothing
   * about them.
   */
  it('attempts the files after one the server refuses', async () => {
    const user = userEvent.setup();
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/documents')) {
        n += 1;
        if (n === 1) return jsonResponse({ detail: 'That file is too large.' }, 413);
        return jsonResponse({ document: { id: `d${n}` } }, 201);
      }
      return jsonResponse({});
    });
    resumeAtUploads();

    await user.upload(picker(), [file('one.pdf'), file('two.pdf'), file('three.pdf')]);

    await waitFor(() => expect(screen.getByText('(2)')).toBeInTheDocument());
    expect(storedUploads()).toEqual({ cap_table: ['two.pdf', 'three.pdf'] });
    // One failure keeps the sentence it has always had.
    expect(screen.getByText('That file is too large.')).toBeInTheDocument();
  });

  it('adds nothing to the checklist when the very first file fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('/documents')
        ? jsonResponse({ detail: 'Unsupported file type.' }, 415)
        : jsonResponse({}),
    );
    resumeAtUploads();

    await user.upload(picker(), file('notes.txt'));

    expect(await screen.findByText('Unsupported file type.')).toBeInTheDocument();
    expect(screen.queryByText('(1)')).not.toBeInTheDocument();
    expect(storedUploads()).toEqual({});
  });

  /*
   * R303. Two ways a failure can carry no message of its own, which this used
   * to conflate — and after R255 routed these handlers through
   * `describeActionFailure`, the single assertion left here matched neither.
   *
   * The operation sentence is a prefix, not the whole message: what follows it
   * says which of the two happened and what the reader should do about it.
   * Asserting the prefix alone passed only while there was nothing after it.
   */
  it('names the operation and the network when the upload never left', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/documents')) throw new Error('offline');
      return jsonResponse({});
    });
    resumeAtUploads();

    await user.upload(picker(), file('cap.pdf'));

    expect(await screen.findByText(`Upload failed. ${OFFLINE_DETAIL}`)).toBeInTheDocument();
  });

  it('names the operation and the status when the server explains nothing', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/documents'))
        return jsonResponse({ title: 'Internal Server Error', status: 500 }, 500);
      return jsonResponse({});
    });
    resumeAtUploads();

    await user.upload(picker(), file('cap.pdf'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Upload failed.');
    expect(alert).toHaveTextContent('unexpected fault (500)');
    expect(alert).not.toHaveTextContent('Internal Server Error');
  });

  /**
   * Retrying a failed upload means picking the same file again — and a file
   * input that still holds that file fires no change event when it is chosen a
   * second time, so the obvious way to recover was a control that did nothing.
   * The fix hands the input back empty after every pick.
   *
   * Asserted on the input rather than through a second upload: jsdom's
   * `user.upload` dispatches change whichever value the input holds, so a
   * two-upload test passes with or without the fix and proves nothing. The
   * emptied value is the part of the behaviour this environment can actually
   * observe.
   */
  it('hands the file input back empty so the same file can be re-picked', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('/documents')
        ? jsonResponse({ detail: 'Temporary glitch.' }, 500)
        : jsonResponse({}),
    );
    resumeAtUploads();

    await user.upload(picker(), file('cap.pdf'));

    expect(await screen.findByText('Temporary glitch.')).toBeInTheDocument();
    expect(picker().value).toBe('');
    expect(picker().files).toHaveLength(0);
  });

  it('adds to the ticks a resumed draft already carried', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('/documents') ? jsonResponse({ document: { id: 'd2' } }, 201) : jsonResponse({}),
    );
    resumeAtUploads({ cap_table: ['already.pdf'] });

    expect(screen.getByText('(1)')).toBeInTheDocument();
    await user.upload(picker(), file('more.pdf'));

    await waitFor(() => expect(screen.getByText('(2)')).toBeInTheDocument());
    expect(storedUploads()).toEqual({ cap_table: ['already.pdf', 'more.pdf'] });
  });

  /** Choosing nothing is not an upload. */
  it('does nothing when the picker is dismissed without a file', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    resumeAtUploads();
    fetchMock.mockClear();

    await userEvent.setup().upload(picker(), []);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** The button names what it does — and uploads are genuinely optional. */
  it('offers to skip while nothing is uploaded, and to finish once something is', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('/documents') ? jsonResponse({ document: { id: 'd1' } }, 201) : jsonResponse({}),
    );
    resumeAtUploads();

    expect(screen.getByRole('button', { name: 'Skip uploads for now →' })).toBeInTheDocument();
    await user.upload(picker(), file('cap.pdf'));

    const finish = await screen.findByRole('button', { name: 'Finish →' });
    await user.click(finish);

    expect(await screen.findByText(/Your request is in/)).toBeInTheDocument();
    expect(screen.getByText(/1 document received/)).toBeInTheDocument();
  });
  /*
   * The quote was loaded with `.catch(() => {})`. It is not fatal — the button
   * still opens checkout and Stripe still quotes the real figure — but a pay
   * step showing no price and giving no reason asks somebody to start a payment
   * blind, and the button's own label silently loses its amount too.
   */
  it('says why the price is missing rather than showing a pay step with none', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/valuations') && init?.method === 'POST') {
        return jsonResponse({ valuation: VALUATION }, 201);
      }
      if (url.includes('/payments/quote')) return jsonResponse({ detail: 'nope' }, 503);
      throw new Error(`unexpected fetch ${url}`);
    });
    renderPage();

    await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme Robotics, Inc.');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await screen.findByText(/price could not be worked out/i);
    expect(screen.queryByTestId('onboarding-quote')).toBeNull();
    // Still payable — the fix explains the absence, it does not block checkout.
    expect(screen.getByRole('button', { name: /with card/i })).not.toBeDisabled();
  });

  it('says nothing of the sort when the quote arrives', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/valuations') && init?.method === 'POST') {
        return jsonResponse({ valuation: VALUATION }, 201);
      }
      if (url.includes('/payments/quote')) {
        return jsonResponse({
          quote: { amount_cents: 119_000, currency: 'USD', kind: '409a', configured: true },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    renderPage();

    await user.type(screen.getByPlaceholderText('Acme Robotics, Inc.'), 'Acme Robotics, Inc.');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByTestId('onboarding-quote')).toHaveTextContent('$1,190.00'));
    expect(screen.queryByText(/price could not be worked out/i)).toBeNull();
  });
});
