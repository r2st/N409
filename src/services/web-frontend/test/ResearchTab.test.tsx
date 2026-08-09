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
});
