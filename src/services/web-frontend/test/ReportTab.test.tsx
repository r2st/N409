import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { ReportTab } from '../src/pages/valuation/ReportTab';
import type { User, Valuation } from '../src/lib/types';

/**
 * The report tab is where the deliverable is written, numbered and rendered.
 *
 * The behaviour that most needs pinning is chapter numbering. Omitting a
 * chapter keeps its text but takes away its number, and every chapter after it
 * moves up — in the outline, in the editor gutter and in the PDF. Those three
 * have to agree, because the number beside a heading is what an analyst uses
 * to check the document against the index of exhibits. They are computed from
 * one `numberOf`, and these tests are what hold that.
 *
 * The other is that ops and a client see different documents from the same
 * content: ops sees every chapter including the omitted ones (hiding has to be
 * reversible from where it was done), a client sees only what the PDF will
 * contain, because a shared draft is a preview of the document and not of the
 * editor.
 */

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'complete',
  company_name: 'Acme Robotics, Inc.',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const opsUser = { id: 'u-ops', email: 'ops@example.com', roles: ['admin'] } as unknown as User;
const clientUser = { id: 'u-c', email: 'c@example.com', roles: ['client'] } as unknown as User;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const REPORT = {
  id: 'r1',
  valuation_id: valuation.id,
  template_version: '409a.v12',
  status: 'draft' as const,
  current_version: 3,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
};

/** Three chapters with the middle one omitted, so numbering has to close up. */
const CONTENT = {
  title: 'Acme Robotics — 409A Valuation',
  sections: [
    { key: 'intro', heading: 'Introduction', html: '<p>Scope of the engagement.</p>' },
    { key: 'dlom', heading: 'Discount for Lack of Marketability', html: '<p>DLOM.</p>', hidden: true },
    { key: 'concl', heading: 'Conclusion of Value', html: '<p>Concluded FMV.</p>' },
  ],
};

const VERSIONS = [
  {
    id: 'v3',
    report_id: 'r1',
    version: 3,
    rendered_at: '2026-02-01T00:00:00.000Z',
    created_by: 'u-ops',
    created_at: '2026-02-01T00:00:00.000Z',
    has_pdf: true,
  },
  {
    id: 'v2',
    report_id: 'r1',
    version: 2,
    rendered_at: null,
    created_by: 'u-ops',
    created_at: '2026-01-15T00:00:00.000Z',
    has_pdf: false,
  },
];

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
  ifMatch: string | null;
}

function mockApi(
  opts: {
    report?: () => Response;
    versions?: () => Response;
    save?: () => Response;
    render?: () => Response;
    narrative?: () => Response;
    revert?: () => Response;
    pdf?: () => Response;
  } = {},
): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      ifMatch: new Headers(init?.headers).get('if-match'),
    });
    if (/\/report\/versions$/.test(url)) {
      return opts.versions ? opts.versions() : json({ versions: VERSIONS });
    }
    if (/\/report\/render$/.test(url)) {
      return opts.render ? opts.render() : json({ version: 4, size_bytes: 2048 });
    }
    if (/\/report\/narrative$/.test(url)) {
      return opts.narrative
        ? opts.narrative()
        : json({ changed: true, version: 4, applied: [{ section_key: 'intro', outcome: 'written' }] });
    }
    if (/\/report\/revert$/.test(url)) return opts.revert ? opts.revert() : json({});
    if (/\/report\.pdf$/.test(url)) {
      return opts.pdf ? opts.pdf() : new Response('%PDF-1.4', { status: 200 });
    }
    if (/\/report$/.test(url) && method === 'PUT') {
      return opts.save
        ? opts.save()
        : json({
            report: { ...REPORT, current_version: 4 },
            version: { version: 4, content: CONTENT },
          });
    }
    if (/\/report$/.test(url)) {
      return opts.report
        ? opts.report()
        : json({ report: REPORT, version: { version: 3, content: CONTENT } });
    }
    // ExplanationCard: nothing to show, so it renders nothing.
    if (/\/explanation$/.test(url)) return json({ explanation: null, model: null, generated_at: null });
    return json({});
  });
  return calls;
}

const problem = (status: number, detail: string) => () => json({ status, title: 'Error', detail }, status);

function renderTab(state: string = valuation.state) {
  return render(
    <MemoryRouter initialEntries={['/report']}>
      <Routes>
        <Route element={<Outlet context={{ valuation: { ...valuation, state }, reload: async () => {} }} />}>
          <Route path="/report" element={<ReportTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const outline = () => screen.getByTestId('report-outline');
const outlineLink = (name: RegExp | string) => within(outline()).getByRole('link', { name });
const ready = () => screen.findByTestId('report-outline');

describe('ReportTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUser = opsUser;
  });

  describe('loading', () => {
    it('waits for the report rather than flashing an empty state', async () => {
      mockApi();
      renderTab();
      expect(screen.getByRole('status')).toBeInTheDocument();
      await ready();
    });

    it('treats a 404 as "not shared yet", not as an error', async () => {
      // A client opening the tab before the analyst shares a draft gets a 404.
      // That is the normal path, and an error note would read as a fault.
      mockUser = clientUser;
      mockApi({ report: problem(404, 'No report') });
      renderTab();
      expect(await screen.findByText('No report yet')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('reports any other failure', async () => {
      mockApi({ report: problem(503, 'The report service is unavailable.') });
      renderTab();
      expect(await screen.findByRole('alert')).toHaveTextContent('The report service is unavailable.');
    });
  });

  /**
   * What the reader is holding, said before they download it.
   *
   * The deliverable is readable here from `drafted` — before the QA review
   * closes, before the signature, before publication — and R92 stamps every
   * page of the PDF it produces. The page has to say the same thing: a client
   * who forwards this to their auditor should know what they are forwarding,
   * and finding out from a diagonal stamp afterwards is finding out too late.
   */
  describe('the draft notice', () => {
    const notice = () => screen.queryByTestId('report-draft-notice');

    it('tells a client the report is not final yet', async () => {
      mockUser = clientUser;
      mockApi();
      renderTab('drafted');
      await ready();
      expect(notice()).toHaveTextContent('This report is a draft.');
      // And says what the download will look like, which is the part a reader
      // would otherwise discover only after sending it on.
      expect(notice()).toHaveTextContent(/every page of the PDF you download is marked/i);
    });

    it('goes away once the engagement is published', async () => {
      mockUser = clientUser;
      mockApi();
      renderTab('published');
      await ready();
      expect(notice()).not.toBeInTheDocument();
    });

    it('keys on the engagement, not on the editorial status of the prose', async () => {
      // `report.status` reaches 'published' as soon as an analyst marks the
      // prose done; the stamp is decided by the *engagement* publishing, which
      // is what the signature and the QA gate stand in front of. Keying the
      // banner on the wrong one would have it disagree with the document.
      mockUser = clientUser;
      mockApi({
        report: () =>
          json({ report: { ...REPORT, status: 'published' }, version: { version: 3, content: CONTENT } }),
      });
      renderTab('drafted');
      await ready();
      expect(notice()).toBeInTheDocument();
    });

    it('does not interrupt the analyst who is writing it', async () => {
      mockUser = opsUser;
      mockApi();
      renderTab('drafted');
      await ready();
      expect(notice()).not.toBeInTheDocument();
    });
  });

  describe('chapter numbering', () => {
    it('gives an omitted chapter no number and closes the gap after it', async () => {
      // Introduction is 1, the omitted DLOM takes none, and Conclusion is 2 —
      // not 3. This is the number the analyst reconciles against the PDF.
      mockApi();
      renderTab();
      await ready();
      expect(outlineLink(/Introduction/)).toHaveTextContent('1');
      expect(outlineLink(/Discount for Lack of Marketability/)).toHaveTextContent('—');
      expect(outlineLink(/Conclusion of Value/)).toHaveTextContent('2');
    });

    it('renumbers the moment a chapter is put back in', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Include' }));
      expect(outlineLink(/Discount for Lack of Marketability/)).toHaveTextContent('2');
      expect(outlineLink(/Conclusion of Value/)).toHaveTextContent('3');
    });

    it('takes a chapter out of the numbering when it is omitted', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      // Omit the introduction: the conclusion becomes the only numbered
      // chapter left ahead of it.
      const intro = screen.getByLabelText('Heading for section 1').closest('section') as HTMLElement;
      await user.click(within(intro).getByRole('button', { name: 'Omit' }));
      expect(outlineLink(/Introduction/)).toHaveTextContent('—');
      expect(outlineLink(/Conclusion of Value/)).toHaveTextContent('1');
    });

    it('links each outline entry at its chapter', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(outlineLink(/Conclusion of Value/)).toHaveAttribute('href', '#report-section-concl');
      expect(document.getElementById('report-section-concl')).toBeInTheDocument();
    });

    it('calls an unnamed chapter Untitled in the outline', async () => {
      mockApi({
        report: () =>
          json({
            report: REPORT,
            version: { version: 3, content: { title: 'T', sections: [{ key: 'k', heading: '', html: '' }] } },
          }),
      });
      renderTab();
      await ready();
      expect(outlineLink(/Untitled/)).toBeInTheDocument();
    });
  });

  describe('what each role sees', () => {
    it('shows ops every chapter, omitted ones included', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByLabelText('Heading for section 2')).toHaveValue(
        'Discount for Lack of Marketability',
      );
      expect(screen.getByText(/Omitted from the rendered report/)).toBeInTheDocument();
    });

    it('shows a client only what the PDF will contain', async () => {
      // The omitted chapter is not "hidden pending review" to a reader — it is
      // simply not part of the document they were sent.
      mockUser = clientUser;
      mockApi();
      renderTab();
      await ready();
      expect(screen.queryByText(/Discount for Lack of Marketability/)).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: '1. Introduction' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: '2. Conclusion of Value' })).toBeInTheDocument();
    });

    it('gives a client no editing controls', async () => {
      mockUser = clientUser;
      mockApi();
      renderTab();
      await ready();
      expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Render PDF' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Draft with AI' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Report title')).not.toBeInTheDocument();
      expect(screen.queryByText('Version history')).not.toBeInTheDocument();
    });

    it('still gives a client the download and the outline', async () => {
      mockUser = clientUser;
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByRole('button', { name: 'Download PDF' })).toBeInTheDocument();
      expect(screen.getByTestId('report-outline')).toBeInTheDocument();
    });

    it('states the template version, the current version and the status', async () => {
      mockApi();
      renderTab();
      await ready();
      // Read through the header strip: "v3" also appears in the version list,
      // and a test that cannot tell them apart would pass on a page showing
      // the wrong one twice.
      const header = screen.getByText('409a.v12').parentElement!;
      expect(header).toHaveTextContent('v3');
      expect(header).toHaveTextContent('· Draft');
    });
  });

  describe('unsaved edits', () => {
    it('enables save and blocks render until the edit is committed', async () => {
      // Rendering from unsaved content would produce a PDF that does not match
      // any stored version, so it is gated rather than silently rendering the
      // last saved text.
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByRole('button', { name: 'Save (new version)' })).toBeDisabled();
      await user.type(screen.getByLabelText('Report title'), '!');
      expect(screen.getByRole('button', { name: 'Save (new version)' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Render PDF' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Draft with AI' })).toBeDisabled();
      expect(screen.getByText(/render is disabled until you save/)).toBeInTheDocument();
    });

    it('counts a heading edit as an edit', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.type(screen.getByLabelText('Heading for section 1'), ' A');
      expect(screen.getByRole('button', { name: 'Save (new version)' })).toBeEnabled();
    });
  });

  describe('saving', () => {
    it('sends the edited content and names the version it became', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await user.type(screen.getByLabelText('Report title'), '!');
      await user.click(screen.getByRole('button', { name: 'Save (new version)' }));
      expect(await screen.findByText('Saved as version 4.')).toBeInTheDocument();
      const put = calls.find((c) => c.method === 'PUT')!;
      expect((put.body!.content as { title: string }).title).toBe('Acme Robotics — 409A Valuation!');
    });

    it('clears the dirty flag once saved', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.type(screen.getByLabelText('Report title'), '!');
      await user.click(screen.getByRole('button', { name: 'Save (new version)' }));
      await screen.findByText('Saved as version 4.');
      expect(screen.getByRole('button', { name: 'Render PDF' })).toBeEnabled();
    });

    it('re-reads the version list so the new version appears', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await user.type(screen.getByLabelText('Report title'), '!');
      await user.click(screen.getByRole('button', { name: 'Save (new version)' }));
      await screen.findByText('Saved as version 4.');
      expect(calls.filter((c) => /\/report\/versions$/.test(c.url)).length).toBeGreaterThanOrEqual(2);
    });

    it('sends the version it loaded so a concurrent save is refused', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await user.type(screen.getByLabelText('Report title'), '!');
      await user.click(screen.getByRole('button', { name: 'Save (new version)' }));
      await screen.findByText('Saved as version 4.');
      expect(calls.find((c) => c.method === 'PUT')!.ifMatch).toBe('"3"');
    });

    /**
     * A conflict here cannot be handled the way the valuation form handles one.
     *
     * There, a 409 reloads the page: the fields are a dozen values and retyping
     * them from the source document is a minute's work. Here the refused
     * payload is the chapters the analyst has been writing, and reloading is
     * exactly how they are lost — so the draft stays on screen, and the button
     * changes to say what saving it would now do.
     */
    describe('when someone else saved first', () => {
      /**
       * The tab loads at v3 and the other analyst's v4 lands between that read
       * and the save — so the second read of `/report`, the one the conflict
       * handler makes, is the first that can see v4.
       */
      const conflicting = () => {
        let reads = 0;
        return mockApi({
          save: problem(
            409,
            'This report was changed by someone else (expected version 3, now 4). ' +
              'Your draft has not been lost — read version 4 before saving over it.',
          ),
          report: () => {
            const version = reads++ === 0 ? 3 : 4;
            return json({
              report: { ...REPORT, current_version: version },
              version: { version, content: CONTENT },
            });
          },
        });
      };

      const conflict = async () => {
        const user = userEvent.setup();
        const calls = conflicting();
        renderTab();
        await ready();
        await user.type(screen.getByLabelText('Report title'), '!');
        await user.click(screen.getByRole('button', { name: 'Save (new version)' }));
        await screen.findByRole('alert');
        return { user, calls };
      };

      it('keeps the analyst’s unsaved draft on screen', async () => {
        await conflict();
        expect(screen.getByLabelText('Report title')).toHaveValue('Acme Robotics — 409A Valuation!');
      });

      it('says which version landed and that the draft survived', async () => {
        await conflict();
        expect(screen.getByRole('alert')).toHaveTextContent('now 4');
        expect(screen.getByRole('alert')).toHaveTextContent('has not been lost');
      });

      it('makes the retry say it will save over their version', async () => {
        await conflict();
        expect(await screen.findByRole('button', { name: 'Save over v4' })).toBeEnabled();
      });

      it('rebases the retry onto their version rather than conflicting forever', async () => {
        const { user, calls } = await conflict();
        await user.click(await screen.findByRole('button', { name: 'Save over v4' }));
        const puts = calls.filter((c) => c.method === 'PUT');
        expect(puts).toHaveLength(2);
        expect(puts[0]!.ifMatch).toBe('"3"');
        expect(puts[1]!.ifMatch).toBe('"4"');
      });
    });

    it('reports a rejected save', async () => {
      const user = userEvent.setup();
      mockApi({ save: problem(409, 'The report was changed by someone else.') });
      renderTab();
      await ready();
      await user.type(screen.getByLabelText('Report title'), '!');
      await user.click(screen.getByRole('button', { name: 'Save (new version)' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The report was changed by someone else.');
    });

    it('names the action when the failure carries no message', async () => {
      mockApi();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
      renderTab();
      // The initial load fails too, so assert through the error it produces.
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the report.');
    });
  });

  describe('rendering the PDF', () => {
    it('reports the version and size it produced', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Render PDF' }));
      expect(await screen.findByText('Rendered v4 (2 KB).')).toBeInTheDocument();
    });

    it('reports a failed render', async () => {
      const user = userEvent.setup();
      mockApi({ render: problem(500, 'The renderer ran out of memory.') });
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Render PDF' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The renderer ran out of memory.');
    });
  });

  describe('drafting with AI', () => {
    it('says how many chapters it wrote', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
      expect(await screen.findByText('Drafted 1 section as version 4.')).toBeInTheDocument();
    });

    it('says what it left alone, because that is the reassurance that matters', async () => {
      // The button is safe to press on a report someone has been editing only
      // because written chapters are kept. Saying so is the whole point.
      const user = userEvent.setup();
      mockApi({
        narrative: () =>
          json({
            changed: true,
            version: 5,
            applied: [
              { section_key: 'a', outcome: 'written' },
              { section_key: 'b', outcome: 'written' },
              { section_key: 'c', outcome: 'kept' },
            ],
          }),
      });
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
      expect(
        await screen.findByText(
          'Drafted 2 sections as version 5 · 1 you had already written were left alone.',
        ),
      ).toBeInTheDocument();
    });

    it('says plainly when there was nothing to do', async () => {
      const user = userEvent.setup();
      mockApi({ narrative: () => json({ changed: false, version: 3, applied: [] }) });
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
      expect(await screen.findByText(/Nothing to draft/)).toBeInTheDocument();
    });
  });

  describe('downloading', () => {
    it('names the file after the company and the current version', async () => {
      // The filename is what the analyst files the deliverable under, and the
      // company name has to survive punctuation that is illegal in one.
      const user = userEvent.setup();
      const created: string[] = [];
      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: () => 'blob:x',
        revokeObjectURL: () => {},
      });
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        created.push(this.download);
      });
      const calls = mockApi();
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Download PDF' }));
      await waitFor(() => expect(created).toHaveLength(1));
      expect(created[0]).toBe('Acme_Robotics_Inc._report_v3.pdf');
      expect(calls.some((c) => /\/report\.pdf$/.test(c.url))).toBe(true);
      click.mockRestore();
      vi.unstubAllGlobals();
    });

    /**
     * And when the server names the file, that name wins over the guess.
     *
     * The real route sends `content-disposition` built from the company name,
     * the engagement kind and the version it actually rendered; the client
     * builds its own from the version it last *loaded*, which is stale the
     * moment somebody else saves. The header is the authority, and this button
     * used to ignore it entirely — it had its own fetch-and-anchor helper that
     * never read the response's headers.
     */
    it("prefers the server's filename when the response carries one", async () => {
      const user = userEvent.setup();
      const created: string[] = [];
      vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        created.push(this.download);
      });
      mockApi({
        pdf: () =>
          new Response('%PDF-1.4', {
            status: 200,
            headers: {
              'content-disposition':
                'inline; filename="Acme Robotics, Inc._409a_v4.pdf"; filename*=UTF-8\'\'Acme%20Robotics%2C%20Inc._409a_v4.pdf',
            },
          }),
      });
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Download PDF' }));
      await waitFor(() => expect(created).toHaveLength(1));
      expect(created[0]).toBe('Acme Robotics, Inc._409a_v4.pdf');
      click.mockRestore();
      vi.unstubAllGlobals();
    });

    /**
     * A failed download says why, when the server said why.
     *
     * The button used to run on a helper that threw a bare
     * `Error('Download failed (500)')`, so every failure rendered as the same
     * "Could not download." — including the ones the server had explained. The
     * one that matters is the 409 the render route answers on a delivered
     * version: "already been delivered — save a new version" is advice, and
     * "Could not download." is not.
     */
    it("shows the server's explanation when a download fails", async () => {
      const user = userEvent.setup();
      mockApi({
        pdf: () =>
          new Response(JSON.stringify({ title: 'Not Found', detail: 'No report yet', status: 404 }), {
            status: 404,
            headers: { 'content-type': 'application/problem+json' },
          }),
      });
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Download PDF' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('No report yet');
    });

    it('still reports a failure whose body explains nothing', async () => {
      // A 502 from the edge is HTML, not problem+json. There is nothing to
      // quote, so the status is the whole of what can honestly be said.
      const user = userEvent.setup();
      mockApi({ pdf: () => new Response('<html>bad gateway</html>', { status: 502 }) });
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Download PDF' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (502)');
    });
  });

  describe('version history', () => {
    it('marks the current version and offers no way to restore it', async () => {
      mockApi();
      renderTab();
      await ready();
      const current = screen.getByText('current').closest('li') as HTMLElement;
      expect(current).toHaveTextContent('v3');
      expect(within(current).queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    });

    it('notes which versions have a rendered PDF', async () => {
      mockApi();
      renderTab();
      await ready();
      const current = screen.getByText('current').closest('li') as HTMLElement;
      expect(within(current).getByText('PDF rendered')).toBeInTheDocument();
    });

    it('restores an older version as a new one', async () => {
      // Restoring forward rather than rewriting history: the version being
      // replaced stays in the list.
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Restore' }));
      expect(await screen.findByText('Restored version 2 as a new version.')).toBeInTheDocument();
      expect(calls.find((c) => /\/report\/revert$/.test(c.url))!.body).toEqual({ version: 2 });
    });

    it('reports a refused restore', async () => {
      const user = userEvent.setup();
      mockApi({ revert: problem(422, 'That version has no content.') });
      renderTab();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Restore' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('That version has no content.');
    });

    it('says so when there are no versions', async () => {
      mockApi({ versions: () => json({ versions: [] }) });
      renderTab();
      await ready();
      expect(screen.getByText('No versions yet.')).toBeInTheDocument();
    });
  });

  describe('omitting a chapter', () => {
    it('keeps the text and says it is kept', async () => {
      // "Omit" that looked like a delete would stop analysts using it, and the
      // text coming back is the property that makes it safe.
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByText(/The text below is kept and will come back/)).toBeInTheDocument();
    });

    it('exposes the omitted state to assistive tech', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByRole('button', { name: 'Include' })).toHaveAttribute('aria-pressed', 'true');
      const intro = screen.getByLabelText('Heading for section 1').closest('section') as HTMLElement;
      expect(within(intro).getByRole('button', { name: 'Omit' })).toHaveAttribute('aria-pressed', 'false');
    });
  });
});
