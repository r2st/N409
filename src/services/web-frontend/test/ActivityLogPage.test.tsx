import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ActivityLogPage } from '../src/pages/ActivityLogPage';

/**
 * The activity log is the append-only record of who did what, and it is what
 * an auditor is pointed at when they ask whether a figure was touched after
 * the board adopted it. Its usefulness is entirely in the filtering.
 *
 * Two things are worth pinning hardest. The "to" date is sent as
 * `T23:59:59Z`, not as the bare date — a bare date is midnight, so an auditor
 * filtering "up to the 14th" would silently lose every event on the 14th,
 * which is exactly the day they are asking about.
 *
 * And "Load more" appends rather than replaces, and carries the *same*
 * filters: a second page fetched under different filters, or one that
 * replaced the first, would present a partial log as a complete one.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const humanEvent = {
  id: 'e1',
  scope: 'valuation' as const,
  type: 'valuation.overwrite.applied',
  actor_type: 'human',
  actor_id: 'u-ops',
  actor_email: 'dana@example.com',
  source: 'web',
  subject_type: 'valuation',
  subject_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  subject_label: 'Acme — 409A',
  payload: { field: 'revenue_ttm', from: 2_500_000, to: 3_100_000 },
  occurred_at: '2026-02-14T10:00:00.000Z',
};

const machineEvent = {
  ...humanEvent,
  id: 'e2',
  scope: 'admin' as const,
  type: 'admin.prompt.updated',
  actor_type: 'ai',
  actor_id: null,
  actor_email: null,
  subject_type: 'prompt',
  subject_id: 'pr-1',
  subject_label: 'Narrative prompt',
  payload: {},
  occurred_at: '2026-02-13T09:00:00.000Z',
};

interface Call {
  url: string;
}

function mockApi(
  opts: { events?: (query: URLSearchParams) => Response; actors?: () => Response } = {},
): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url });
    if (/\/users\/options/.test(url)) {
      return opts.actors ? opts.actors() : json({ options: [{ id: 'u-ops', email: 'dana@example.com' }] });
    }
    if (/\/admin\/events/.test(url)) {
      const query = new URLSearchParams(url.split('?')[1] ?? '');
      return opts.events
        ? opts.events(query)
        : json({ events: [humanEvent, machineEvent], page: 1, per_page: 50, total: 2 });
    }
    return json({});
  });
  return calls;
}

const problem = (status: number, detail: string) => () => json({ status, title: 'Error', detail }, status);

const renderPage = (entry = '/activity') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/activity" element={<ActivityLogPage />} />
      </Routes>
    </MemoryRouter>,
  );

const ready = () => screen.findByRole('table', { name: 'Activity log' });
const eventCalls = (calls: Call[]) => calls.filter((c) => /\/admin\/events/.test(c.url));
/** The query the most recent events request carried. */
const lastQuery = (calls: Call[]) => new URLSearchParams(eventCalls(calls).at(-1)!.url.split('?')[1] ?? '');

describe('ActivityLogPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('loading', () => {
    it('asks for the first page at the fixed page size', async () => {
      const calls = mockApi();
      renderPage();
      await ready();
      const query = lastQuery(calls);
      expect(query.get('page')).toBe('1');
      expect(query.get('per_page')).toBe('50');
    });

    it('sends no scope when the filter is "all"', async () => {
      // "all" is the absence of a scope, not a scope named "all".
      const calls = mockApi();
      renderPage();
      await ready();
      expect(lastQuery(calls).has('scope')).toBe(false);
    });

    it('says plainly that the log is operations-only on a 403', async () => {
      mockApi({ events: problem(403, 'Forbidden') });
      renderPage();
      expect(await screen.findByRole('alert')).toHaveTextContent('The activity log is operations-only.');
    });

    it('gives a generic message for any other failure', async () => {
      mockApi({ events: problem(500, 'boom') });
      renderPage();
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the activity log.');
    });

    it('says when nothing matches, rather than showing an empty table', async () => {
      mockApi({ events: () => json({ events: [], page: 1, per_page: 50, total: 0 }) });
      renderPage();
      expect(await screen.findByText('No activity matches these filters')).toBeInTheDocument();
      expect(screen.queryByRole('table', { name: 'Activity log' })).not.toBeInTheDocument();
    });

    it('carries on when the actor list cannot be fetched', async () => {
      // The actor picker is a convenience; losing it must not cost the log.
      mockApi({ actors: problem(500, 'boom') });
      renderPage();
      await ready();
      expect(screen.getByLabelText('Actor')).toBeInTheDocument();
    });
  });

  describe('the log', () => {
    it('names a human actor by email and a machine one by its kind', async () => {
      mockApi();
      renderPage();
      await ready();
      const human = screen.getByText('valuation.overwrite.applied').closest('tr') as HTMLElement;
      expect(within(human).getByText('dana@example.com')).toBeInTheDocument();
      const machine = screen.getByText('admin.prompt.updated').closest('tr') as HTMLElement;
      expect(within(machine).getByText('ai')).toBeInTheDocument();
    });

    it('falls back to the actor id, then to unknown, for a human with no email', async () => {
      mockApi({
        events: () =>
          json({
            events: [
              { ...humanEvent, id: 'a', actor_email: null },
              { ...humanEvent, id: 'b', type: 'other.event', actor_email: null, actor_id: null },
            ],
            page: 1,
            per_page: 50,
            total: 2,
          }),
      });
      renderPage();
      await ready();
      expect(screen.getByText('u-ops')).toBeInTheDocument();
      expect(screen.getByText('unknown')).toBeInTheDocument();
    });

    it('links a valuation event straight at the valuation', async () => {
      mockApi();
      renderPage();
      await ready();
      expect(screen.getByRole('link', { name: 'Acme — 409A' })).toHaveAttribute(
        'href',
        '/valuations/01JZZZZZZZZZZZZZZZZZZZZZZZ',
      );
    });

    it('names the subject type for anything that is not a valuation', async () => {
      mockApi();
      renderPage();
      await ready();
      const machine = screen.getByText('admin.prompt.updated').closest('tr') as HTMLElement;
      expect(machine).toHaveTextContent('Narrative prompt');
      expect(machine).toHaveTextContent('(prompt)');
    });

    it('summarises the payload as key/value pairs', async () => {
      mockApi();
      renderPage();
      await ready();
      const human = screen.getByText('valuation.overwrite.applied').closest('tr') as HTMLElement;
      expect(human).toHaveTextContent('field: revenue_ttm · from: 2500000 · to: 3100000');
    });

    it('shows an em dash for an event that carries no payload', async () => {
      mockApi();
      renderPage();
      await ready();
      const machine = screen.getByText('admin.prompt.updated').closest('tr') as HTMLElement;
      expect(within(machine).getByText('—')).toBeInTheDocument();
    });

    it('skips empty payload entries and abbreviates nested ones', async () => {
      mockApi({
        events: () =>
          json({
            events: [
              {
                ...humanEvent,
                payload: {
                  kept: 'yes',
                  blank: '',
                  missing: null,
                  list: ['a', 'b'],
                  nested: { deep: 1 },
                },
              },
            ],
            page: 1,
            per_page: 50,
            total: 1,
          }),
      });
      renderPage();
      await ready();
      const row = screen.getByText('valuation.overwrite.applied').closest('tr') as HTMLElement;
      expect(row).toHaveTextContent('kept: yes');
      expect(row).toHaveTextContent('list: a, b');
      expect(row).toHaveTextContent('nested: …');
      expect(row).not.toHaveTextContent('blank:');
      expect(row).not.toHaveTextContent('missing:');
    });

    it('shows at most four payload entries', async () => {
      mockApi({
        events: () =>
          json({
            events: [{ ...humanEvent, payload: { a: 1, b: 2, c: 3, d: 4, e: 5 } }],
            page: 1,
            per_page: 50,
            total: 1,
          }),
      });
      renderPage();
      await ready();
      const row = screen.getByText('valuation.overwrite.applied').closest('tr') as HTMLElement;
      expect(row).toHaveTextContent('a: 1 · b: 2 · c: 3 · d: 4');
      expect(row).not.toHaveTextContent('e: 5');
    });
  });

  describe('filtering', () => {
    it('sends the scope once one is chosen', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await user.selectOptions(screen.getByLabelText('Scope'), 'admin');
      await waitFor(() => expect(lastQuery(calls).get('scope')).toBe('admin'));
    });

    it('sends the actor as actor_id', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await user.selectOptions(screen.getByLabelText('Actor'), 'u-ops');
      await waitFor(() => expect(lastQuery(calls).get('actor_id')).toBe('u-ops'));
    });

    it('sends the actor type', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await user.selectOptions(screen.getByLabelText('Actor type'), 'engine');
      await waitFor(() => expect(lastQuery(calls).get('actor_type')).toBe('engine'));
    });

    it('takes the end date as the end of that day, not its midnight', async () => {
      // A bare date is midnight, so "up to the 14th" would drop every event on
      // the 14th — the day the question is usually about.
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await user.type(screen.getByLabelText('To date'), '2026-02-14');
      await waitFor(() => expect(lastQuery(calls).get('to')).toBe('2026-02-14T23:59:59Z'));
    });

    it('sends the start date as given', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await user.type(screen.getByLabelText('From date'), '2026-02-01');
      await waitFor(() => expect(lastQuery(calls).get('from')).toBe('2026-02-01'));
    });

    it('commits the event type when the box loses focus', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await user.type(screen.getByLabelText('Event type'), '  valuation.calculated  ');
      await user.tab();
      await waitFor(() => expect(lastQuery(calls).get('type')).toBe('valuation.calculated'));
    });

    it('commits the event type on Enter without reloading the page', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage();
      await ready();
      await user.type(screen.getByLabelText('Event type'), 'valuation.calculated{Enter}');
      await waitFor(() => expect(lastQuery(calls).get('type')).toBe('valuation.calculated'));
    });

    it('drops a filter that is cleared rather than sending it empty', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPage('/activity?scope=admin');
      await ready();
      await user.selectOptions(screen.getByLabelText('Scope'), 'all');
      await waitFor(() => expect(lastQuery(calls).has('scope')).toBe(false));
    });

    it('starts from the filters already in the URL', async () => {
      // The page is linkable: an auditor shares the filtered view, not the
      // instructions for reproducing it.
      const calls = mockApi();
      renderPage('/activity?scope=admin&actor_type=ai&type=admin.prompt.updated');
      await ready();
      const query = lastQuery(calls);
      expect(query.get('scope')).toBe('admin');
      expect(query.get('actor_type')).toBe('ai');
      expect(query.get('type')).toBe('admin.prompt.updated');
      expect(screen.getByLabelText('Event type')).toHaveValue('admin.prompt.updated');
    });
  });

  describe('paging', () => {
    it('reports how much of the log is on screen', async () => {
      mockApi({
        events: () => json({ events: [humanEvent, machineEvent], page: 1, per_page: 50, total: 120 }),
      });
      renderPage();
      await ready();
      expect(screen.getByText('Showing 2 of 120')).toBeInTheDocument();
    });

    it('offers no "load more" once everything is shown', async () => {
      mockApi();
      renderPage();
      await ready();
      expect(screen.getByText('Showing 2 of 2')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    it('appends the next page rather than replacing the first', async () => {
      const user = userEvent.setup();
      const calls = mockApi({
        events: (query) =>
          query.get('page') === '2'
            ? json({
                events: [{ ...humanEvent, id: 'e3', type: 'valuation.calculated' }],
                page: 2,
                per_page: 50,
                total: 3,
              })
            : json({ events: [humanEvent, machineEvent], page: 1, per_page: 50, total: 3 }),
      });
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByText('valuation.calculated')).toBeInTheDocument();
      // The first page is still there — a replace would present a partial log
      // as a complete one.
      expect(screen.getByText('admin.prompt.updated')).toBeInTheDocument();
      expect(screen.getByText('Showing 3 of 3')).toBeInTheDocument();
      expect(lastQuery(calls).get('page')).toBe('2');
    });

    it('carries the active filters onto the next page', async () => {
      const user = userEvent.setup();
      const calls = mockApi({
        events: (query) =>
          json({
            events: query.get('page') === '2' ? [{ ...humanEvent, id: 'e3' }] : [humanEvent, machineEvent],
            page: Number(query.get('page')),
            per_page: 50,
            total: 3,
          }),
      });
      renderPage('/activity?scope=admin');
      await ready();
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(() => expect(lastQuery(calls).get('page')).toBe('2'));
      expect(lastQuery(calls).get('scope')).toBe('admin');
    });

    it('reports a failed "load more" without losing what is already shown', async () => {
      const user = userEvent.setup();
      mockApi({
        events: (query) =>
          query.get('page') === '2'
            ? json({ status: 500, title: 'Error', detail: 'boom' }, 500)
            : json({ events: [humanEvent, machineEvent], page: 1, per_page: 50, total: 3 }),
      });
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load more activity.');
      expect(screen.getByText('admin.prompt.updated')).toBeInTheDocument();
    });
  });

  // ── What the page said to somebody not looking at it (R117) ───────────────

  describe('announcing', () => {
    it('says how many events six unlabelled-as-filters controls left', async () => {
      // Scope, Actor, Actor type, Event type, From and To rewrite the table and
      // never move focus. None of them is *called* a filter, which is why the
      // source census missed the page for as long as it did.
      mockApi({
        events: (query) =>
          json({
            events: query.get('scope') === 'admin' ? [machineEvent] : [humanEvent, machineEvent],
            page: 1,
            per_page: 50,
            total: query.get('scope') === 'admin' ? 1 : 2,
          }),
      });
      const user = userEvent.setup();
      renderPage();
      await ready();

      const announced = () => screen.getAllByRole('status').map((el) => el.textContent);
      await waitFor(() => expect(announced()).toContain('2 events'));

      await user.selectOptions(screen.getByLabelText('Scope'), 'admin');
      await waitFor(() => expect(announced()).toContain('1 event'));
    });

    it('says so when the filters leave nothing, rather than going quiet', async () => {
      mockApi({ events: () => json({ events: [], page: 1, per_page: 50, total: 0 }) });
      renderPage();
      await screen.findByText('No activity matches these filters');
      expect(screen.getAllByRole('status').map((el) => el.textContent)).toContain('No events');
    });

    it('moves to the first appended row instead of dropping focus on the floor', async () => {
      // "Load more" removes itself on the last page, so focus fell back to
      // <body> and the next Tab restarted at the top of the document — and the
      // rows it had just fetched arrived unannounced. The first new row answers
      // both, and is where a reader working down the list wants to be.
      const user = userEvent.setup();
      mockApi({
        events: (query) =>
          query.get('page') === '2'
            ? json({
                events: [{ ...humanEvent, id: 'e3', type: 'valuation.calculated' }],
                page: 2,
                per_page: 50,
                total: 3,
              })
            : json({ events: [humanEvent, machineEvent], page: 1, per_page: 50, total: 3 }),
      });
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Load more' }));

      const appended = (await screen.findByText('valuation.calculated')).closest('tr');
      await waitFor(() => expect(document.activeElement).toBe(appended));
      // The button has now retired; focus is on the log, not on nothing.
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
      expect(document.activeElement).not.toBe(document.body);
    });

    it('falls back to the summary when the next page turns out to be empty', async () => {
      // The log shrank under the reader: page 2 is empty but the button was
      // still on screen. There is no new row to move to, and dropping focus is
      // still not an option.
      const user = userEvent.setup();
      mockApi({
        events: (query) =>
          query.get('page') === '2'
            ? json({ events: [], page: 2, per_page: 50, total: 2 })
            : json({ events: [humanEvent, machineEvent], page: 1, per_page: 50, total: 3 }),
      });
      renderPage();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Load more' }));

      await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Showing 2 of 2')));
    });

    it('does not re-announce the same total just because somebody paged', async () => {
      // Paging appends; it does not change how many events match. Sharing one
      // loading flag blanked the region and repeated the count, which is a
      // status message reporting that nothing happened.
      const user = userEvent.setup();
      mockApi({
        events: (query) =>
          query.get('page') === '2'
            ? json({ events: [{ ...humanEvent, id: 'e3' }], page: 2, per_page: 50, total: 3 })
            : json({ events: [humanEvent, machineEvent], page: 1, per_page: 50, total: 3 }),
      });
      renderPage();
      await ready();
      const region = screen.getAllByRole('status').find((el) => el.textContent === '3 events')!;
      expect(region).toBeDefined();

      // Watched rather than sampled: a region that blanks and refills is back
      // to '3 events' by the time the assertion runs, and a screen reader has
      // already said it twice. Only the mutations show that.
      const seen: string[] = [];
      const observer = new MutationObserver(() => seen.push(region.textContent ?? ''));
      observer.observe(region, { childList: true, characterData: true, subtree: true });

      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(() => expect(screen.getByText('Showing 3 of 3')).toBeInTheDocument());
      observer.disconnect();

      expect(seen).toEqual([]);
      expect(region.textContent).toBe('3 events');
    });
  });
  /*
   * The actor roster was loaded with `.catch(() => {})`. A filter offering only
   * "Any actor" is indistinguishable from a log nobody has ever written to,
   * which is the opposite of what an activity log is consulted to establish.
   */
  describe('when the actor roster fails to load', () => {
    it('says so in the control itself', async () => {
      mockApi({ actors: problem(503, 'nope') });
      renderPage();
      await ready();

      const select = screen.getByRole('combobox', { name: 'Actor' });
      expect(select).toBeDisabled();
      expect(select).toHaveTextContent('Actor list unavailable');
    });

    it('leaves the log itself readable', async () => {
      // The roster is a filter, not the page — losing it must not cost the
      // events somebody opened this page to read.
      mockApi({ actors: problem(503, 'nope') });
      renderPage();
      await ready();

      expect(screen.getByRole('table', { name: 'Activity log' })).toBeInTheDocument();
    });

    it('offers the ordinary label when the roster loads', async () => {
      mockApi();
      renderPage();
      await ready();

      const select = screen.getByRole('combobox', { name: 'Actor' });
      expect(select).not.toBeDisabled();
      expect(select).toHaveTextContent('Any actor');
      expect(select).not.toHaveTextContent('unavailable');
    });
  });
});
