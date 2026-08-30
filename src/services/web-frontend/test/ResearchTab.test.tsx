import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { ResearchTab } from '../src/pages/valuation/ResearchTab';
import type { Valuation } from '../src/lib/types';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', roles: ['admin'] } }),
}));

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'review',
  company_name: 'Zorblatt Dynamics',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const TOPICS = {
  topics: [
    {
      topic: 'industry_overview',
      label: 'Industry overview',
      description: 'What the industry comprises.',
      regionScoped: false,
      acceptsSubject: false,
    },
    {
      topic: 'market_conditions',
      label: 'Market conditions',
      description: 'Deal activity in one named market.',
      regionScoped: true,
      acceptsSubject: false,
    },
    {
      topic: 'company_overview',
      label: 'Guideline company overview',
      description: 'The public record on one guideline company.',
      regionScoped: false,
      acceptsSubject: true,
    },
  ],
  regions: [
    { key: 'us', label: 'US' },
    { key: 'uk', label: 'UK' },
  ],
  stale_days: 90,
};

const RESEARCH = {
  research: [
    {
      id: '01JRESEARCHAAAAAAAAAAAAAAA',
      topic: 'industry_overview',
      region: null,
      question: 'Give an overview of the industrial robotics industry…',
      answer: 'The sector consolidated through 2025.',
      citations: [{ url: 'https://example.com/report', title: 'Robotics review 2026' }],
      model: 'sonar',
      created_at: '2026-07-01T00:00:00Z',
      stale: false,
      grounded: true,
    },
    {
      id: '01JRESEARCHBBBBBBBBBBBBBBB',
      topic: 'market_conditions',
      region: 'uk',
      question: 'What are current market conditions…',
      answer: 'UK multiples compressed in Q2.',
      citations: [],
      model: 'sonar-pro',
      created_at: '2026-01-01T00:00:00Z',
      stale: true,
      grounded: false,
    },
  ],
  stale_days: 90,
  can_run: true,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(onPost?: (path: string, init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if ((init?.method ?? 'GET') === 'POST' && onPost) return onPost(path, init!);
    if (path.includes('/research/topics')) return jsonResponse(TOPICS);
    if (path.includes('/research')) return jsonResponse(RESEARCH);
    throw new Error(`unexpected fetch ${path}`);
  });
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/research']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/research" element={<ResearchTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ResearchTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * R226. `topics` is `meta?.topics ?? []`, and `meta` is null for the whole
   * of the registry's round trip — so for the seconds before it answered, an
   * engagement with no research yet was told "No market research yet — set the
   * industry on the Company tab, then run a topic", and then handed the three
   * topic cards that instruction says do not exist. The registry not having
   * answered is not the registry being empty.
   */
  it('does not send an analyst to the Company tab while the topics are still loading', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/research/topics')) return new Promise(() => {}) as Promise<Response>;
      return jsonResponse({ ...RESEARCH, research: [] });
    });
    renderTab();

    // The tab itself has arrived — the blurb above the list is on screen.
    await screen.findByText(/Web-grounded research from public sources/);
    expect(screen.queryByText('No market research yet')).not.toBeInTheDocument();
  });

  it('says there is none once the registry comes back empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/research/topics')) return jsonResponse({ ...TOPICS, topics: [] });
      return jsonResponse({ ...RESEARCH, research: [] });
    });
    renderTab();

    expect(await screen.findByText('No market research yet')).toBeInTheDocument();
  });

  it('renders an answer with its sources as links', async () => {
    mockApi();
    renderTab();
    expect(await screen.findByText('The sector consolidated through 2025.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Robotics review 2026' });
    expect(link).toHaveAttribute('href', 'https://example.com/report');
    // Opened away from the app, and without handing the target a window handle.
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  /**
   * The URL on a citation is the one string on this tab that neither this app
   * nor its operators wrote: it comes from whichever search backend the
   * deployment has configured, by way of a model choosing which hits to cite.
   * It used to land in `href` untouched.
   */
  it('will not turn a citation into a link the browser would execute', async () => {
    const hostile = {
      ...RESEARCH,
      research: [
        {
          ...RESEARCH.research[0],
          citations: [
            { url: 'javascript:alert(1)', title: 'Looks like a source' },
            { url: 'https://example.com/ok', title: 'Actually a source' },
          ],
        },
      ],
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/research/topics')) return jsonResponse(TOPICS);
      if (path.includes('/research')) return jsonResponse(hostile);
      throw new Error(`unexpected fetch ${path}`);
    });
    renderTab();
    // Still shown — a source that cannot be followed is still evidence, and an
    // analyst who cannot see it cannot judge the answer that rests on it.
    expect(await screen.findByText('Looks like a source')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Looks like a source' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Actually a source' })).toHaveAttribute(
      'href',
      'https://example.com/ok',
    );
  });

  /**
   * The citation list is the deliverable as much as the answer. An answer with
   * none is an ordinary completion, and the tab has to say so before it reaches
   * a report rather than after.
   */
  it('warns plainly when an answer came back ungrounded', async () => {
    mockApi();
    renderTab();
    expect(await screen.findByText(/do not quote it/i)).toBeInTheDocument();
  });

  it('flags research older than the window', async () => {
    mockApi();
    renderTab();
    await screen.findByText('UK multiples compressed in Q2.');
    expect(screen.getByText('stale')).toBeInTheDocument();
  });

  /** The evidence that only public fields reached the search provider. */
  it('shows the question that was actually asked', async () => {
    mockApi();
    renderTab();
    expect(
      await screen.findByText(/Give an overview of the industrial robotics industry/),
    ).toBeInTheDocument();
  });

  it('sends the region with a region-scoped run', async () => {
    let body: unknown;
    mockApi((path, init) => {
      body = JSON.parse(String(init.body));
      return jsonResponse({ research: RESEARCH.research[0] }, 201);
    });
    renderTab();
    await screen.findByText('UK multiples compressed in Q2.');

    // Scoped to the market card: the tab renders one Refresh per topic, and
    // clicking whichever comes first would pass while proving nothing.
    const card = screen.getByRole('heading', { name: 'Market conditions' }).closest('section')!;
    await userEvent.selectOptions(within(card).getByRole('combobox'), 'uk');
    await userEvent.click(within(card).getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(body).toMatchObject({ topic: 'market_conditions', region: 'uk' }));
  });

  it('will not run a guideline lookup without a company named', async () => {
    mockApi();
    renderTab();
    await screen.findByText('The sector consolidated through 2025.');
    const buttons = screen.getAllByRole('button', { name: /run research/i });
    // The guideline card's button — the only one gated on a text field.
    expect(buttons.some((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('surfaces a refused run rather than failing silently', async () => {
    mockApi(() => jsonResponse({ status: 422, detail: 'Set the industry on the Company tab first.' }, 422));
    renderTab();
    await screen.findByText('The sector consolidated through 2025.');
    const card = screen.getByRole('heading', { name: 'Industry overview' }).closest('section')!;
    await userEvent.click(within(card).getByRole('button', { name: /refresh/i }));
    expect(await screen.findByText(/Set the industry on the Company tab first/)).toBeInTheDocument();
  });

  /**
   * A topic whose search worked and whose write-up did not. The sources are
   * on the card and there is no answer above them, which without a label reads
   * as a bug in the tab rather than as a topic waiting to be re-run.
   */
  describe('a topic retrieved but never summarised', () => {
    const unsynthesized = {
      ...RESEARCH,
      research: [
        {
          ...RESEARCH.research[0],
          answer: 'Sources were retrieved for this question but could not be summarised.',
          model: 'duckduckgo+unsynthesized',
          grounded: false,
          synthesized: false,
        },
      ],
    };

    const mockUnsynthesized = () =>
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const path = String(url);
        if (path.includes('/research/topics')) return jsonResponse(TOPICS);
        if (path.includes('/research')) return jsonResponse(unsynthesized);
        throw new Error(`unexpected fetch ${path}`);
      });

    it('labels the card so the empty write-up reads as a retry, not a bug', async () => {
      mockUnsynthesized();
      renderTab();
      expect(await screen.findByText('not summarised')).toBeInTheDocument();
    });

    it('says the sources were kept and the topic should be re-run', async () => {
      mockUnsynthesized();
      renderTab();
      expect(await screen.findByText(/re-run them to get a written answer/i)).toBeInTheDocument();
    });

    it('still shows the retrieved sources, because they are the point', async () => {
      // The whole reason the AI service stopped discarding them.
      mockUnsynthesized();
      renderTab();
      const link = await screen.findByRole('link', { name: 'Robotics review 2026' });
      expect(link).toHaveAttribute('href', 'https://example.com/report');
    });

    it('does not label an ordinary answer', async () => {
      mockApi();
      renderTab();
      await screen.findByText('The sector consolidated through 2025.');
      expect(screen.queryByText('not summarised')).not.toBeInTheDocument();
    });
  });
  /*
   * The topic registry is loaded separately from the research itself, and its
   * failure was discarded — leaving `topics` empty, which the empty state reads
   * as a fact: "No market research yet — set the industry on the Company tab,
   * then run a topic." An analyst who follows that finds the industry already
   * set and comes back to the same page with no topic to run, because the list
   * the instruction refers to is the one that never arrived.
   */
  describe('when the topic registry fails to load', () => {
    const mockTopicsDown = (research: unknown = { research: [], stale_days: 90, can_run: true }) =>
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const path = String(url);
        if (path.includes('/research/topics')) return jsonResponse({ detail: 'nope' }, 503);
        if (path.includes('/research')) return jsonResponse(research);
        throw new Error(`unexpected fetch ${path}`);
      });

    it('does not hand out an instruction it has made unfollowable', async () => {
      mockTopicsDown();
      renderTab();

      await screen.findByText(/list of research topics could not be loaded/);
      expect(screen.queryByText('No market research yet')).toBeNull();
    });

    it('still says there is none when the registry loads and there genuinely is none', async () => {
      // The other half: the empty state is correct when it is earned, and the
      // fix must not have made it unreachable.
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const path = String(url);
        if (path.includes('/research/topics')) return jsonResponse({ topics: [], regions: [] });
        if (path.includes('/research')) return jsonResponse({ research: [], stale_days: 90, can_run: true });
        throw new Error(`unexpected fetch ${path}`);
      });
      renderTab();

      await screen.findByText('No market research yet');
      expect(screen.queryByText(/could not be loaded/)).toBeNull();
    });
  });
});
