import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TemplatesPage } from '../src/pages/TemplatesPage';
import type { ReportTemplate } from '../src/lib/types';

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

function mockApi(onWrite?: (path: string, init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      if (onWrite) return onWrite(path, init!);
      return jsonResponse({ ok: true });
    }
    if (path.includes('/report-templates')) return jsonResponse({ templates: TEMPLATES });
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

  it('will not submit an unnamed template', async () => {
    mockApi();
    renderPage();
    await screen.findByText('409a.v54');

    await userEvent.click(screen.getByRole('button', { name: /New version/i }));
    expect(screen.getByRole('button', { name: /Create draft/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^Template name/), 'x');
    expect(screen.getByRole('button', { name: /Create draft/i })).toBeEnabled();
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
