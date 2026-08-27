import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagsPanel } from '../src/components/valuation/TagsPanel';

/**
 * Engagement tags — the browser half of parity gap #23.
 *
 * The panel's job is to make three server rules unexpressible rather than
 * merely refused, so those three are what is pinned here:
 *
 *   * an AI-sourced tag is *rejected*, never deleted — the row's `source`
 *     decides which control it gets, and offering "Remove" on an AI row would
 *     produce a 422 the analyst can do nothing about;
 *   * a suggestion is not yet a claim, so it is listed apart from the accepted
 *     set rather than mixed in;
 *   * the catalogue is closed and comes from the server, so the picker offers
 *     what the API served and never a hard-coded list.
 *
 * And the fourth, which is not a tag rule at all: a list that failed to load
 * must not render as an untagged engagement.
 */

const VAL = '01N409VAL000000000000000AA';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (detail: string, status = 422) =>
  new Response(JSON.stringify({ title: 'Unprocessable', status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

const CATEGORIES = [
  {
    category: 'stage',
    label: 'Stage',
    exclusive: true,
    tags: [
      { slug: 'seed', label: 'Seed', definition: 'Raised a seed round.' },
      { slug: 'series_a', label: 'Series A', definition: 'Raised a Series A.' },
    ],
  },
  {
    category: 'business_model',
    label: 'Business model',
    exclusive: false,
    tags: [{ slug: 'saas', label: 'SaaS', definition: 'Subscription software.' }],
  },
];

interface TagOverrides {
  slug: string;
  label: string;
  source?: 'manual' | 'ai';
  status?: 'suggested' | 'accepted' | 'rejected';
  confidence?: number | null;
  rationale?: string | null;
  evidence?: string[] | null;
  known?: boolean;
}

const tag = (o: TagOverrides) => ({
  slug: o.slug,
  label: o.label,
  definition: 'A definition.',
  category: 'stage',
  known: o.known ?? true,
  source: o.source ?? 'manual',
  status: o.status ?? 'accepted',
  confidence: o.confidence ?? null,
  rationale: o.rationale ?? null,
  evidence: o.evidence ?? null,
  decided_at: null,
  created_at: '2026-08-01T00:00:00.000Z',
});

interface Sent {
  path: string;
  method: string;
  body: unknown;
}

/**
 * `tags` is the reply to the *first* GET; each later GET shifts one off, so a
 * test can say what the list looks like after a write without the mock having
 * to model the write.
 */
function mockApi(pages: Array<ReturnType<typeof tag>[]>, onWrite?: () => Response) {
  const sent: Sent[] = [];
  const queue = [...pages];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({
        path,
        method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (onWrite) return onWrite();
      return path.endsWith('/apply')
        ? jsonResponse({ tags: [], applied: ['saas'], unknown: [] })
        : jsonResponse({});
    }
    if (path.endsWith('/tags')) {
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      return jsonResponse({ tags: next, categories: CATEGORIES });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
  return sent;
}

const renderPanel = (canWrite = true) => render(<TagsPanel valuationId={VAL} canWrite={canWrite} />);

describe('TagsPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says the list could not be loaded rather than showing an untagged engagement', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem('Nope', 500));
    renderPanel();

    expect(await screen.findByText(/Nope/)).toBeInTheDocument();
    // The empty-state sentence is the one an analyst would read as "this file
    // has no tags", and it is exactly wrong here.
    expect(screen.queryByText(/No tags yet/)).not.toBeInTheDocument();
  });

  /**
   * A 200 with the wrong body is the only failure that can reach the render,
   * and it took the whole tab down: `res.tags.filter` on an absent field throws
   * inside React, which the route boundary catches as a crashed screen. The
   * panel is mounted on the Company tab, so what an analyst saw was the company
   * profile disappearing because a *tag* payload was short a field.
   */
  it('treats a 200 with no tag array as a failed load, not as a crash', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    renderPanel();

    expect(await screen.findByText(/Could not load the engagement tags/)).toBeInTheDocument();
    expect(screen.queryByText(/No tags yet/)).not.toBeInTheDocument();
  });

  it('lists suggestions apart from accepted tags, with the model’s reasoning', async () => {
    mockApi([
      [
        tag({ slug: 'saas', label: 'SaaS' }),
        tag({
          slug: 'series_a',
          label: 'Series A',
          source: 'ai',
          status: 'suggested',
          confidence: 0.82,
          rationale: 'The term sheet names a Series A.',
          evidence: ['term_sheet.pdf'],
        }),
      ],
    ]);
    renderPanel();

    expect(await screen.findByText('Suggested by the tagging agent')).toBeInTheDocument();
    expect(screen.getByText('82% confident')).toBeInTheDocument();
    expect(screen.getByText('The term sheet names a Series A.')).toBeInTheDocument();
    expect(screen.getByText(/term_sheet\.pdf/)).toBeInTheDocument();
    // The suggestion is not in the accepted set — it is a claim nobody has made.
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject Series A' })).not.toBeInTheDocument();
  });

  it('rejects an AI-sourced accepted tag and deletes a manual one', async () => {
    const sent = mockApi([
      [
        tag({ slug: 'saas', label: 'SaaS', source: 'manual' }),
        tag({ slug: 'series_a', label: 'Series A', source: 'ai' }),
      ],
    ]);
    renderPanel();

    // Named for what they do. The AI row has no delete control at all, so the
    // server's "an AI-suggested tag is rejected rather than deleted" 422 is a
    // backstop for other clients rather than something an analyst can trip.
    const removeManual = await screen.findByRole('button', { name: 'Remove SaaS' });
    expect(screen.queryByRole('button', { name: 'Remove Series A' })).not.toBeInTheDocument();
    const rejectAi = screen.getByRole('button', { name: 'Reject Series A' });

    await userEvent.click(removeManual);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('DELETE');
    expect(sent[0]!.path).toContain('/tags/saas');

    await userEvent.click(rejectAi);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.method).toBe('PATCH');
    expect(sent[1]!.path).toContain('/tags/series_a');
    expect(sent[1]!.body).toEqual({ status: 'rejected' });
  });

  it('builds the picker from the served catalogue and hides tags already held', async () => {
    mockApi([[tag({ slug: 'saas', label: 'SaaS' })]]);
    renderPanel();

    const picker = await screen.findByLabelText('Add a tag');
    expect(picker).toHaveTextContent('Seed');
    expect(picker).toHaveTextContent('Series A');
    // Already on the engagement — offering it again is either a no-op or a way
    // to reopen a decision by accident.
    expect(picker).not.toHaveTextContent('SaaS');
    // The exclusive group says so, because "one only" is the rule that makes
    // adding Series A silently demote Seed.
    expect(picker.innerHTML).toContain('Stage (one only)');
  });

  it('adds the chosen tag and re-reads the list rather than guessing at exclusivity', async () => {
    const sent = mockApi([
      [tag({ slug: 'seed', label: 'Seed' })],
      // What the server actually did: the incumbent was demoted, which the
      // panel learns by re-reading rather than by predicting.
      [
        tag({ slug: 'seed', label: 'Seed', status: 'rejected' }),
        tag({ slug: 'series_a', label: 'Series A' }),
      ],
    ]);
    renderPanel();

    await userEvent.selectOptions(await screen.findByLabelText('Add a tag'), 'series_a');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.body).toEqual({ slug: 'series_a' });
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Accept Seed' })).toBeInTheDocument();
  });

  it('runs the tagging agent and reports slugs the catalogue does not carry', async () => {
    const sent = mockApi([[]], () =>
      jsonResponse({ tags: [], applied: ['saas', 'seed'], unknown: ['ai_infrastructure'] }),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Suggest tags with AI' }));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]!.path).toContain('/ai/tagging');
    expect(sent[1]!.path).toContain('/ai/tagging/apply');
    // Surfaced to the operator, who is the person who can extend the
    // vocabulary — the server returns it rather than logging it for exactly
    // this reason, and eating it here would put it back in a log.
    expect(await screen.findByText(/ai_infrastructure/)).toBeInTheDocument();
    expect(screen.getByText(/Suggested 2 tags for review/)).toBeInTheDocument();
  });

  /**
   * Both directions, because "the control is disabled for a client" passes
   * just as well against a panel whose control is disabled always — which is
   * the worse bug, and the silent one. See `RetiredTabControls.test.tsx`.
   */
  it('shows a client the classification with the row controls closed', async () => {
    mockApi([[tag({ slug: 'saas', label: 'SaaS' })]]);
    renderPanel(false);

    expect(await screen.findByText('SaaS')).toBeInTheDocument();
    // Disabled rather than absent — the `WriteGate` fieldset is what closes
    // them, so a control somebody adds inside it next year is closed too.
    expect(screen.getByRole('button', { name: 'Remove SaaS' })).toBeDisabled();
    // The add row and the agent button are gone entirely: neither is a view of
    // the engagement, so a client has nothing to read from a greyed-out copy.
    expect(screen.queryByLabelText('Add a tag')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suggest tags with AI' })).not.toBeInTheDocument();
  });

  it('leaves the same controls open for operations', async () => {
    mockApi([[tag({ slug: 'saas', label: 'SaaS' })]]);
    renderPanel(true);

    expect(await screen.findByRole('button', { name: 'Remove SaaS' })).toBeEnabled();
    expect(screen.getByLabelText('Add a tag')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suggest tags with AI' })).toBeInTheDocument();
  });

  it('surfaces a refused write instead of leaving the row looking changed', async () => {
    mockApi([[tag({ slug: 'saas', label: 'SaaS' })]], () =>
      problem('This engagement is retired and no longer accepts changes'),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove SaaS' }));
    expect(await screen.findByText(/retired and no longer accepts changes/)).toBeInTheDocument();
    expect(screen.getByText('SaaS')).toBeInTheDocument();
  });
});
