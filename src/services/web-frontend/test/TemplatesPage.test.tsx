import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TemplatesPage } from '../src/pages/TemplatesPage';
import type { ReportTemplate, ReportTemplateSummary } from '../src/lib/types';

const template = (over: Partial<ReportTemplate>): ReportTemplate => ({
  id: '01JTEMPLATE000000000000001',
  name: '409a',
  version: 1,
  label: '409a.v1',
  kind: '409a',
  status: 'active',
  body: '# 409A report\n',
  notes: null,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
  ...over,
});

const TEMPLATES: ReportTemplate[] = [
  template({ id: 't-active', label: '409a.v54', version: 54, status: 'active' }),
  template({
    id: 't-draft',
    label: '409a.v55',
    version: 55,
    status: 'draft',
    body: '# draft body\n',
  }),
  template({
    id: 't-archived',
    name: 'qsbs',
    kind: 'qsbs',
    label: 'qsbs.v3',
    version: 3,
    status: 'archived',
  }),
];

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

/**
 * THE LIST CARRIES NO BODY, AND SAYING SO HERE IS THE GUARD (R398, M8).
 *
 * `GET /report-templates` stopped sending it — a template body is the report
 * skeleton, capped at a million characters, and a page of 200 versions was that
 * many copies of it over the wire to draw a table of labels and timestamps. The
 * page therefore has to fetch the one body it reads, and the only way a test
 * can see the difference is to serve the list the way the route now does: with
 * the field absent. Anything that goes back to reading `t.body` off a list row
 * opens an empty editor here.
 */
const summaries: ReportTemplateSummary[] = TEMPLATES.map(({ body: _body, ...rest }) => rest);

/** Detail fetches this run made, so a test can assert the body came from one. */
let detailFetches: string[] = [];

function mockApi(
  onWrite?: (path: string, init: RequestInit) => Response,
  onDetail?: (id: string) => Response,
) {
  detailFetches = [];
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      if (onWrite) return onWrite(path, init!);
      return jsonResponse({ ok: true });
    }
    const detail = /\/report-templates\/([^/?]+)$/.exec(path);
    if (detail) {
      const id = detail[1]!;
      detailFetches.push(id);
      if (onDetail) return onDetail(id);
      const found = TEMPLATES.find((t) => t.id === id);
      if (!found) return problem(404, 'No such template');
      return jsonResponse({ template: found });
    }
    if (path.includes('/report-templates')) return jsonResponse({ templates: summaries });
    throw new Error(`unexpected fetch ${path}`);
  });
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <TemplatesPage />
    </MemoryRouter>,
  );

/** The action row for a template, keyed by the version label in its first cell. */
const rowFor = (label: string) => screen.getByText(label).closest('tr')!;

describe('TemplatesPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('groups versions under their template name', async () => {
    mockApi();
    renderPage();
    await screen.findByText('409a.v54');

    // Two names → two sections, and the qsbs version does not appear under 409a.
    expect(screen.getByRole('heading', { name: '409a' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'qsbs' })).toBeInTheDocument();
    const tables = screen.getAllByRole('table');
    expect(tables).toHaveLength(2);
    expect(within(tables[0]!).getByText('409a.v55')).toBeInTheDocument();
    expect(within(tables[0]!).queryByText('qsbs.v3')).not.toBeInTheDocument();
  });

  it('shows each version status and its valuation kind', async () => {
    mockApi();
    renderPage();
    await screen.findByText('409a.v54');
    expect(rowFor('409a.v54')).toHaveTextContent('active');
    expect(rowFor('409a.v55')).toHaveTextContent('draft');
    expect(rowFor('qsbs.v3')).toHaveTextContent('archived');
    expect(rowFor('409a.v54')).toHaveTextContent('IRC §409A');
    expect(rowFor('qsbs.v3')).toHaveTextContent('QSBS');
  });

  it('explains a 403 as an operations-only screen', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem(403, 'Forbidden'));
    renderPage();
    await screen.findByText(/operations-only/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('reports a non-403 load failure rather than spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderPage();
    await screen.findByText(/Could not load templates/i);
  });

  it('offers an empty state when no template has ever been created', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ templates: [] }));
    renderPage();
    await screen.findByText(/No templates yet/i);
  });

  it('only exposes activate and edit on a draft', async () => {
    mockApi();
    renderPage();
    await screen.findByText('409a.v54');

    const draft = within(rowFor('409a.v55'));
    expect(draft.getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(draft.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(draft.getByRole('button', { name: 'Archive' })).toBeInTheDocument();

    // An active version is not editable in place — editing a published
    // template would rewrite the document behind reports already issued on it.
    const active = within(rowFor('409a.v54'));
    expect(active.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
    expect(active.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(active.getByRole('button', { name: 'Archive' })).toBeInTheDocument();

    // Archiving twice is meaningless.
    expect(within(rowFor('qsbs.v3')).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('activates a draft and reloads the list', async () => {
    const writes: string[] = [];
    mockApi((path, init) => {
      writes.push(`${init.method} ${path}`);
      return jsonResponse({ ok: true });
    });
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(within(rowFor('409a.v55')).getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(writes).toEqual(['POST /api/v1/report-templates/t-draft/activate']));
  });

  it('archives a version', async () => {
    const writes: string[] = [];
    mockApi((path, init) => {
      writes.push(`${init.method} ${path}`);
      return jsonResponse({ ok: true });
    });
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(within(rowFor('409a.v54')).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(writes).toEqual(['POST /api/v1/report-templates/t-active/archive']));
  });

  it('surfaces the server message when an action is refused', async () => {
    mockApi(() => problem(409, 'the only active template cannot be archived'));
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(within(rowFor('409a.v54')).getByRole('button', { name: 'Archive' }));
    await screen.findByText('the only active template cannot be archived');
    // The list survives the failed action — it is not replaced by the error.
    expect(screen.getByText('409a.v55')).toBeInTheDocument();
  });

  /*
   * Four operations shared one wrapper and one message, "Action failed." — on a
   * table of many rows, where activating is what decides the skeleton every
   * 409A rendered from here uses next. The operation half is what the reader
   * sees whenever the server sent no sentence of its own, which the test above
   * is the other side of.
   */
  it('names the action when the server sent no sentence of its own', async () => {
    mockApi(() => jsonResponse({ status: 500, title: 'Internal Server Error' }, 500));
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(within(rowFor('409a.v55')).getByRole('button', { name: 'Activate' }));
    const message = await screen.findByText(/Could not activate that template version\./);
    expect(message).not.toHaveTextContent(/Action failed/);
    // And not the reason phrase, which is the one string in a detail-less body
    // guaranteed not to be about this request.
    expect(message).not.toHaveTextContent('Internal Server Error');
  });

  it('tells archiving apart from activating', async () => {
    mockApi(() => jsonResponse({ status: 500, title: 'Internal Server Error' }, 500));
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(within(rowFor('409a.v54')).getByRole('button', { name: 'Archive' }));
    await screen.findByText(/Could not archive that template\./);
  });

  it('edits a draft body and PATCHes it, then closes the editor', async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    mockApi((path, init) => {
      writes.push({ path, body: JSON.parse(String(init.body)) as unknown });
      return jsonResponse({ ok: true });
    });
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(within(rowFor('409a.v55')).getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByDisplayValue('# draft body');
    await userEvent.type(editor, ' revised');
    await userEvent.click(screen.getByRole('button', { name: /Save draft/i }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.path).toContain('/report-templates/t-draft');
    expect(writes[0]!.body).toEqual({ body: '# draft body\n revised' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Save draft/i })).not.toBeInTheDocument(),
    );
  });

  it('closes the editor on a second click of the same row', async () => {
    mockApi();
    renderPage();
    await screen.findByText('409a.v54');

    const draft = () => within(rowFor('409a.v55'));
    await userEvent.click(draft().getByRole('button', { name: 'Edit' }));
    expect(await screen.findByDisplayValue('# draft body')).toBeInTheDocument();
    await userEvent.click(draft().getByRole('button', { name: 'Close' }));
    expect(screen.queryByDisplayValue('# draft body')).not.toBeInTheDocument();
  });

  /*
   * R398, methodology M8 — the three tests the narrowing is actually about.
   *
   * The list stopped carrying `body`, so the editor's contents now come from a
   * request that can be slow and can fail. Each of those is a state the screen
   * has to be able to be in truthfully: the body arrives from the detail route
   * and not from the row; the button says so while it is in flight; and a
   * refusal is said out loud rather than opening an empty box, which would read
   * as a template whose body is blank and would save that blankness over the
   * draft on the next press.
   */
  it('fetches the body from the detail route rather than reading it off the row', async () => {
    mockApi();
    renderPage();
    await screen.findByText('409a.v54');
    expect(detailFetches).toEqual([]);

    await userEvent.click(within(rowFor('409a.v55')).getByRole('button', { name: 'Edit' }));
    expect(await screen.findByDisplayValue('# draft body')).toBeInTheDocument();
    // Exactly the row that was pressed, and only it: the list of 200 versions
    // is what this round stopped paying for.
    expect(detailFetches).toEqual(['t-draft']);
  });

  it('says the body is on its way, and does not open a second editor while it is', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi(undefined, (id) => {
      const found = TEMPLATES.find((t) => t.id === id)!;
      return jsonResponse({ template: found });
    });
    // Hold the detail response open by delaying the page's own fetch call.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const passthrough = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (url, init) => {
      if (/\/report-templates\/[^/?]+$/.test(String(url)) && (init?.method ?? 'GET') === 'GET') {
        await held;
      }
      return passthrough(url, init);
    });

    renderPage();
    await screen.findByText('409a.v54');
    await userEvent.click(within(rowFor('409a.v55')).getByRole('button', { name: 'Edit' }));

    expect(await within(rowFor('409a.v55')).findByRole('button', { name: 'Opening…' })).toBeDisabled();
    // Every other row's Edit is held too, so a second press cannot land a
    // different template's body in an editor the first press opened.
    expect(within(rowFor('409a.v54')).queryByRole('button', { name: 'Edit' })).toBeNull();

    release!();
    expect(await screen.findByDisplayValue('# draft body')).toBeInTheDocument();
  });

  it('says so when the body could not be fetched, rather than opening an empty editor', async () => {
    mockApi(undefined, () => problem(503, 'The template store is unavailable.'));
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(within(rowFor('409a.v55')).getByRole('button', { name: 'Edit' }));

    // The server's own sentence, because this is a GET and `describeLoadFailure`
    // prefers a `detail` the server wrote over the page's fallback.
    expect(await screen.findByText(/The template store is unavailable\./i)).toBeInTheDocument();
    // The one thing that must not happen: an editor holding "" that the next
    // Save draft would write over the draft's real body.
    expect(screen.queryByRole('textbox', { name: /Body of the 409a template/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save draft/i })).toBeNull();
    // And the row is pressable again, so the operator can retry.
    expect(within(rowFor('409a.v55')).getByRole('button', { name: 'Edit' })).toBeEnabled();
  });

  it('falls back to its own sentence when the refusal carried none', async () => {
    mockApi(undefined, () => new Response('', { status: 502 }));
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(within(rowFor('409a.v55')).getByRole('button', { name: 'Edit' }));

    expect(await screen.findByText(/Could not open that template for editing\./i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Body of the 409a template/i })).toBeNull();
  });

  it('creates a new version with the name and the selected kind', async () => {
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    mockApi((path, init) => {
      writes.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return jsonResponse({ ok: true }, 201);
    });
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(screen.getByRole('button', { name: /New version/i }));
    await userEvent.type(screen.getByLabelText(/^Template name/), 'qsbs');
    await userEvent.selectOptions(screen.getByLabelText('Valuation kind'), 'qsbs');
    await userEvent.type(screen.getByLabelText(/^Template body/), '# body');
    await userEvent.click(screen.getByRole('button', { name: /Create draft/i }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.path).toContain('/report-templates');
    expect(writes[0]!.body).toEqual({ name: 'qsbs', kind: 'qsbs', body: '# body' });
    // The form closes and resets on success.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Create draft/i })).not.toBeInTheDocument(),
    );
  });

  it('refuses to submit a name the template naming rule rejects', async () => {
    const writes: string[] = [];
    mockApi((path) => {
      writes.push(path);
      return jsonResponse({ ok: true }, 201);
    });
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(screen.getByRole('button', { name: /New version/i }));
    // A name with capitals and a space would mint a template label no URL and
    // no report header could carry; the pattern stops it at the form.
    await userEvent.type(screen.getByLabelText(/^Template name/), 'Bad Name');
    await userEvent.click(screen.getByRole('button', { name: /Create draft/i }));

    expect(screen.getByLabelText(/^Template name/)).toBeInvalid();
    expect(writes).toHaveLength(0);
  });

  it('offers the existing template names as completions so a version lands on the right lineage', async () => {
    mockApi();
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(screen.getByRole('button', { name: /New version/i }));
    const list = document.getElementById('template-names')!;
    expect(list.querySelectorAll('option')).toHaveLength(2);
    expect(list.innerHTML).toContain('409a');
    expect(list.innerHTML).toContain('qsbs');
  });

  it('keeps the create form open and reports the failure when the POST is refused', async () => {
    mockApi(() => problem(409, '409a already has an unpublished draft'));
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(screen.getByRole('button', { name: /New version/i }));
    await userEvent.type(screen.getByLabelText(/^Template name/), '409a');
    await userEvent.click(screen.getByRole('button', { name: /Create draft/i }));

    await screen.findByText('409a already has an unpublished draft');
    expect(screen.getByDisplayValue('409a')).toBeInTheDocument();
  });

  /**
   * A transport failure carries no problem document, so it is not an ApiError
   * and takes the page's own wording — otherwise an activate that never
   * reached the server looks like one that succeeded.
   */
  it('falls back to its own wording when an action fails without a problem document', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') !== 'GET') throw new TypeError('network down');
      return jsonResponse({ templates: TEMPLATES });
    });
    renderPage();
    await screen.findByText('409a.v55');

    await userEvent.click(screen.getAllByRole('button', { name: 'Activate' })[0]!);

    // R357: the wording it falls back to now names the action. It was "Action
    // failed." for all four of this page's writes, on a table of many rows.
    expect(await screen.findByText(/Could not activate that template version\./)).toBeInTheDocument();
  });

  /**
   * R31 — the submit button used to be disabled until the name box held
   * something, which is a rule you can only discover by guessing. It now
   * submits and says what is missing.
   */
  it('will not submit an unnamed template, and says which box', async () => {
    const fetchSpy = mockApi();
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(screen.getByRole('button', { name: /New version/i }));
    await userEvent.click(screen.getByRole('button', { name: /Create draft/i }));

    expect(await screen.findByText('Template name is required.')).toBeInTheDocument();
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  /**
   * The name is the identity a version is minted under, and the route rejects
   * anything outside the slug shape. The box carried a `pattern` attribute the
   * browser stopped honouring once the form was marked `noValidate`.
   */
  it('refuses a template name that is not a slug', async () => {
    const fetchSpy = mockApi();
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(screen.getByRole('button', { name: /New version/i }));
    await userEvent.type(screen.getByLabelText(/^Template name/), '409A Report!');
    await userEvent.click(screen.getByRole('button', { name: /Create draft/i }));

    expect(
      await screen.findByText(
        'Use lower-case letters, digits, hyphens and underscores, starting with a letter or digit.',
      ),
    ).toBeInTheDocument();
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('accepts a well-formed name and posts the draft', async () => {
    const fetchSpy = mockApi();
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(screen.getByRole('button', { name: /New version/i }));
    await userEvent.type(screen.getByLabelText(/^Template name/), 'qsbs_short');
    await userEvent.click(screen.getByRole('button', { name: /Create draft/i }));

    await waitFor(() => {
      const post = fetchSpy.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post![1]!.body)).name).toBe('qsbs_short');
    });
  });

  it('toggles the create form closed again', async () => {
    mockApi();
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(screen.getByRole('button', { name: /New version/i }));
    expect(screen.getByLabelText(/^Template name/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.queryByLabelText(/^Template name/)).not.toBeInTheDocument();
  });
});
