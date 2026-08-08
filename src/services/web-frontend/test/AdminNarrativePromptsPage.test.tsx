import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminNarrativePromptsPage } from '../src/pages/AdminNarrativePromptsPage';

const BASE_ROWS = [
  {
    id: '01JNARRATIVEBASE0000000001',
    kind: null,
    section_key: 'executive_summary',
    label: 'Executive Summary',
    guidance: 'the engagement and the concluded fair market value per share',
    sort_order: 10,
    enabled: true,
    default_guidance: 'the engagement and the concluded fair market value per share',
    updated_at: '2026-07-01T00:00:00Z',
  },
  {
    id: '01JNARRATIVEBASE0000000002',
    kind: null,
    section_key: 'dlom_analysis',
    label: 'Discount for Lack of Marketability',
    guidance: 'the DLOM method chosen and the resulting discount',
    // Edited away from what it shipped as — the page should say so.
    default_guidance: 'the DLOM method chosen, the factors considered, and the discount',
    sort_order: 70,
    enabled: true,
    updated_at: '2026-07-02T00:00:00Z',
  },
];

const QSBS_ROW = {
  id: '01JNARRATIVEQSBS0000000001',
  kind: 'qsbs',
  section_key: 'dlom_analysis',
  label: 'Not applicable',
  guidance: 'state that no marketability discount applies to a §1202 determination',
  sort_order: 70,
  enabled: false,
  default_guidance: 'state that no marketability discount applies to a §1202 determination',
  updated_at: '2026-07-03T00:00:00Z',
};

const PREVIEW = {
  kind: 'qsbs',
  sections: [
    {
      key: 'executive_summary',
      label: 'Executive Summary',
      guidance: 'the engagement and the concluded value',
      overridden: false,
    },
    {
      key: 'gross_asset_test',
      label: 'Gross Assets Test',
      guidance: 'the aggregate gross assets against the $50m ceiling',
      overridden: true,
    },
  ],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(onWrite?: (path: string, init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET' && onWrite) return onWrite(path, init!);
    if (path.includes('/narrative-prompts/preview/')) return jsonResponse(PREVIEW);
    if (path.includes('/admin/narrative-prompts')) {
      return jsonResponse({ prompts: [...BASE_ROWS, QSBS_ROW], kinds: ['409a', 'qsbs', 'gifts'] });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
}

describe('AdminNarrativePromptsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('opens on the base library and lists its sections', async () => {
    mockApi();
    render(<AdminNarrativePromptsPage />);
    expect(await screen.findByText('Executive Summary')).toBeInTheDocument();
    expect(screen.getByText('Discount for Lack of Marketability')).toBeInTheDocument();
    // The QSBS override is not the base library and must not appear here.
    expect(screen.queryByText('Not applicable')).not.toBeInTheDocument();
  });

  it('marks a row whose guidance has drifted from what it shipped as', async () => {
    // Without it, a reviewer cannot tell an edited library from a seeded one,
    // which is the first thing they need to know before editing further.
    mockApi();
    render(<AdminNarrativePromptsPage />);
    expect(await screen.findByText('edited')).toBeInTheDocument();
  });

  it('counts each report type’s overrides in the selector', async () => {
    mockApi();
    render(<AdminNarrativePromptsPage />);
    await screen.findByText('Executive Summary');
    expect(screen.getByRole('option', { name: /QSBS — 1 override/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /409A — no overrides/i })).toBeInTheDocument();
  });

  /**
   * The panel that earns its place: base-plus-override resolution is what an
   * editor gets wrong unaided, and answering "what will a QSBS report actually
   * be drafted with" otherwise takes running a valuation.
   */
  it('previews the assembled section list for a report type', async () => {
    mockApi();
    render(<AdminNarrativePromptsPage />);
    await screen.findByText('Executive Summary');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'qsbs');

    // The preview lists a section the base library does not have at all, which
    // is the resolution an editor cannot work out from the rows on screen.
    expect(await screen.findByText('Gross Assets Test')).toBeInTheDocument();
    expect(screen.getByText('gross_asset_test')).toBeInTheDocument();
    // …and both the preview row and the editable card mark it as an override.
    expect(screen.getAllByText('override').length).toBeGreaterThan(1);
  });

  it('shows a disabled override as off, and says what turning one off means', async () => {
    mockApi();
    render(<AdminNarrativePromptsPage />);
    await screen.findByText('Executive Summary');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'qsbs');

    expect(await screen.findByText('Not applicable')).toBeInTheDocument();
    expect(screen.getByText('off')).toBeInTheDocument();
    expect(screen.getByText(/suppresses the base section too/)).toBeInTheDocument();
  });

  it('saves an edited section', async () => {
    let body: unknown;
    let path = '';
    mockApi((p, init) => {
      path = p;
      body = JSON.parse(String(init.body));
      return jsonResponse({ prompt: BASE_ROWS[0] });
    });
    render(<AdminNarrativePromptsPage />);
    await screen.findByText('Executive Summary');

    const textareas = screen.getAllByRole('textbox').filter((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textareas[0]!, { target: { value: 'a firmer opening paragraph' } });
    await userEvent.click(screen.getAllByRole('button', { name: /save section/i })[0]!);

    await waitFor(() => expect(body).toMatchObject({ guidance: 'a firmer opening paragraph' }));
    expect(path).toContain(BASE_ROWS[0]!.id);
  });

  it('counts unsaved edits so they are not lost by accident', async () => {
    mockApi();
    render(<AdminNarrativePromptsPage />);
    await screen.findByText('Executive Summary');

    const textareas = screen.getAllByRole('textbox').filter((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(textareas[0]!, { target: { value: 'changed' } });
    expect(await screen.findByText('1 unsaved section')).toBeInTheDocument();
  });

  it('resets a section to its seeded text on confirmation', async () => {
    let method = '';
    let path = '';
    mockApi((p, init) => {
      method = String(init.method);
      path = p;
      return jsonResponse({ prompt: { ...BASE_ROWS[1], guidance: BASE_ROWS[1]!.default_guidance } });
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<AdminNarrativePromptsPage />);
    await screen.findByText('Discount for Lack of Marketability');
    await userEvent.click(screen.getByRole('button', { name: /reset to default/i }));

    await waitFor(() => expect(method).toBe('POST'));
    expect(path).toContain('/reset');
  });

  it('says plainly when a report type has no overrides at all', async () => {
    mockApi();
    render(<AdminNarrativePromptsPage />);
    await screen.findByText('Executive Summary');
    await userEvent.selectOptions(screen.getByRole('combobox'), '409a');
    expect(await screen.findByText(/No overrides for this report type/)).toBeInTheDocument();
  });

  it('explains an access refusal instead of showing an empty library', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 403 }, 403));
    render(<AdminNarrativePromptsPage />);
    expect(await screen.findByText(/operations-only/i)).toBeInTheDocument();
  });
});
