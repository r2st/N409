import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminNarrativePromptsPage } from '../src/pages/AdminNarrativePromptsPage';

/**
 * The library editor's refusals and failures: the sort order that is not a
 * number, both writes failing, the two confirmations declined, the preview that
 * will not load, and the counts that have to agree with themselves in number.
 */

const base = (over: Record<string, unknown> = {}) => ({
  id: '01JNARRATIVEBASE0000000001',
  kind: null,
  section_key: 'executive_summary',
  label: 'Executive Summary',
  guidance: 'the engagement and the concluded fair market value per share',
  sort_order: 10,
  enabled: true,
  default_guidance: 'the engagement and the concluded fair market value per share',
  updated_at: '2026-07-01T00:00:00Z',
  ...over,
});

const EDITED = base({
  id: '01JNARRATIVEBASE0000000002',
  section_key: 'dlom_analysis',
  label: 'Discount for Lack of Marketability',
  guidance: 'the DLOM method chosen\nand the resulting discount',
  default_guidance: 'the DLOM method chosen\nthe factors considered\nand the discount',
  sort_order: 70,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Setup {
  prompts?: Array<Record<string, unknown>>;
  kinds?: string[];
  preview?: { status: number; body?: unknown };
  /** Fail every non-GET: 'problem' carries a title, 'network' carries none. */
  writeFails?: 'problem' | 'network';
  listStatus?: number;
}

/**
 * The rows are held rather than re-served from the fixture, because a card's
 * "Saved." is `saved && !dirty` — it only appears once the reload agrees with
 * what was typed, which a stateless mock never does.
 */
function mockApi(opts: Setup = {}) {
  const writes: Array<{ path: string; method: string; body: unknown }> = [];
  const rows = (opts.prompts ?? [base(), EDITED]).map((r) => ({ ...r }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      writes.push({ path, method, body });
      if (opts.writeFails === 'network') throw new TypeError('Failed to fetch');
      if (opts.writeFails === 'problem')
        return new Response(
          JSON.stringify({
            title: 'Unprocessable Content',
            status: 422,
            detail: 'guidance must not be empty',
          }),
          {
            status: 422,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      const row = rows.find((r) => path.includes(String(r.id)));
      if (row && body) Object.assign(row, body);
      if (row && path.endsWith('/reset')) row.guidance = row.default_guidance;
      return jsonResponse({ prompt: row ?? base() });
    }
    if (path.includes('/narrative-prompts/preview/')) {
      const p = opts.preview ?? { status: 200, body: { sections: [] } };
      return jsonResponse(p.body ?? {}, p.status);
    }
    if (path.includes('/admin/narrative-prompts')) {
      if (opts.listStatus && opts.listStatus !== 200)
        return jsonResponse({ status: opts.listStatus }, opts.listStatus);
      return jsonResponse({ prompts: rows, kinds: opts.kinds ?? ['409a', 'qsbs'] });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
  return writes;
}

const textareas = () => screen.getAllByRole('textbox').filter((el) => el.tagName === 'TEXTAREA');

describe('AdminNarrativePromptsPage — refusals and failures', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('saving a section', () => {
    it('refuses a sort order that is not a whole number, before sending it', async () => {
      const writes = mockApi();
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      const order = screen.getAllByLabelText('Sort order')[0]!;
      await userEvent.clear(order);
      await userEvent.type(order, '10.5');
      await userEvent.click(screen.getAllByRole('button', { name: /save section/i })[0]!);

      expect(
        await screen.findByText('Sort order must be a whole number between 0 and 10000.'),
      ).toBeInTheDocument();
      expect(writes).toHaveLength(0);
    });

    it.each([
      ['a negative order', '-1'],
      ['an order past the ceiling', '10001'],
      ['letters', 'first'],
    ])('refuses %s the same way', async (_label, value) => {
      const writes = mockApi();
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      const order = screen.getAllByLabelText('Sort order')[0]!;
      await userEvent.clear(order);
      await userEvent.type(order, value);
      await userEvent.click(screen.getAllByRole('button', { name: /save section/i })[0]!);

      expect(await screen.findByText(/whole number between 0 and 10000/)).toBeInTheDocument();
      expect(writes).toHaveLength(0);
    });

    it('will not save a section whose guidance has been emptied', async () => {
      mockApi();
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      fireEvent.change(textareas()[0]!, { target: { value: '   ' } });
      // A section with no guidance is not guidance the model can follow, and
      // the button says so by being unusable rather than by a 422.
      expect(screen.getAllByRole('button', { name: /save section/i })[0]!).toBeDisabled();
    });

    it("repeats the API's own refusal on the card that produced it", async () => {
      mockApi({ writeFails: 'problem' });
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      fireEvent.change(textareas()[0]!, { target: { value: 'a firmer opening' } });
      await userEvent.click(screen.getAllByRole('button', { name: /save section/i })[0]!);

      expect(await screen.findByText('guidance must not be empty')).toBeInTheDocument();
      expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
    });

    it('falls back to its own words when the failure carries none', async () => {
      mockApi({ writeFails: 'network' });
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      fireEvent.change(textareas()[0]!, { target: { value: 'a firmer opening' } });
      await userEvent.click(screen.getAllByRole('button', { name: /save section/i })[0]!);

      expect(await screen.findByText(/Could not save the section\./)).toBeInTheDocument();
    });

    /**
     * The confirmation has to survive the reload the save triggers, and it has
     * to go away the moment the section is edited again — a "Saved." sitting
     * over an unsaved edit is worse than none.
     */
    it('says so once a section has saved, and stops saying so on the next edit', async () => {
      mockApi();
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      fireEvent.change(textareas()[0]!, { target: { value: 'a firmer opening' } });
      await userEvent.click(screen.getAllByRole('button', { name: /save section/i })[0]!);
      expect(await screen.findByText('Saved.')).toBeInTheDocument();

      fireEvent.change(textareas()[0]!, { target: { value: 'firmer still' } });
      expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
    });
  });

  describe('resetting a section', () => {
    it('does nothing at all when the confirmation is declined', async () => {
      const writes = mockApi();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Discount for Lack of Marketability');

      await userEvent.click(screen.getByRole('button', { name: /reset to default/i }));
      expect(writes).toHaveLength(0);
    });

    it('says so when the reset does not land', async () => {
      mockApi({ writeFails: 'network' });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Discount for Lack of Marketability');

      await userEvent.click(screen.getByRole('button', { name: /reset to default/i }));
      expect(await screen.findByText(/Could not reset the section\./)).toBeInTheDocument();
    });

    it('offers no reset on a section still carrying the text it shipped with', async () => {
      mockApi({ prompts: [base()] });
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      expect(screen.queryByRole('button', { name: /reset to default/i })).not.toBeInTheDocument();
      expect(screen.queryByText('edited')).not.toBeInTheDocument();
    });

    /** Both halves of the change, so a reviewer sees what a reset would undo. */
    it('shows the lines the edit dropped as well as the ones it added', async () => {
      mockApi();
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Discount for Lack of Marketability');

      const diff = screen.getByText('What changed from the default').closest('details')!;
      expect(within(diff).getByText(/^−\s*the factors considered$/)).toBeInTheDocument();
      expect(within(diff).getByText(/^\+\s*and the resulting discount$/)).toBeInTheDocument();
    });
  });

  describe('switching report type with unsaved edits', () => {
    it('stays where it is when the warning is declined', async () => {
      mockApi();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      fireEvent.change(textareas()[0]!, { target: { value: 'changed' } });
      await screen.findByText('1 unsaved section');
      await userEvent.selectOptions(screen.getByRole('combobox'), 'qsbs');

      // Neither the selection nor the edit moved.
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('__base__');
      expect(screen.getByText('1 unsaved section')).toBeInTheDocument();
    });

    it('goes, and forgets the edits, when the warning is accepted', async () => {
      mockApi();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      fireEvent.change(textareas()[0]!, { target: { value: 'changed' } });
      await screen.findByText('1 unsaved section');
      await userEvent.selectOptions(screen.getByRole('combobox'), 'qsbs');

      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('qsbs');
      expect(screen.queryByText(/unsaved section/)).not.toBeInTheDocument();
    });

    it('asks nothing when there is nothing to lose', async () => {
      mockApi();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      await userEvent.selectOptions(screen.getByRole('combobox'), 'qsbs');
      expect(confirm).not.toHaveBeenCalled();
    });

    it('counts two unsaved sections as two', async () => {
      mockApi();
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      fireEvent.change(textareas()[0]!, { target: { value: 'changed' } });
      fireEvent.change(textareas()[1]!, { target: { value: 'also changed' } });
      expect(await screen.findByText('2 unsaved sections')).toBeInTheDocument();
    });

    it('stops counting a section once it is edited back to what it was', async () => {
      mockApi();
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      const box = textareas()[0]!;
      fireEvent.change(box, { target: { value: 'changed' } });
      await screen.findByText('1 unsaved section');
      fireEvent.change(box, { target: { value: base().guidance } });

      await waitFor(() => expect(screen.queryByText(/unsaved section/)).not.toBeInTheDocument());
    });
  });

  describe('the preview panel', () => {
    it('says so when the resolution cannot be loaded', async () => {
      mockApi({ preview: { status: 500, body: { title: 'nope' } } });
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');
      await userEvent.selectOptions(screen.getByRole('combobox'), 'qsbs');

      expect(await screen.findByText('Could not load the preview.')).toBeInTheDocument();
    });

    it('says a kind that resolves to nothing falls back to the built-in sections', async () => {
      mockApi({ preview: { status: 200, body: { sections: [] } } });
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');
      await userEvent.selectOptions(screen.getByRole('combobox'), 'qsbs');

      expect(
        await screen.findByText(/the agent falls back to its built-in 409A sections/),
      ).toBeInTheDocument();
    });

    it('names a report type this build has no label for by its key', async () => {
      // A kind added server-side ahead of the frontend: the selector and the
      // preview heading must still say which one is on screen.
      mockApi({ kinds: ['409a', 'esop_annual_uk'] });
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      expect(screen.getByRole('option', { name: /esop_annual_uk/ })).toBeInTheDocument();
      await userEvent.selectOptions(screen.getByRole('combobox'), 'esop_annual_uk');
      expect(await screen.findByText(/A esop_annual_uk report drafts these sections/)).toBeInTheDocument();
    });
  });

  describe('the library as a whole', () => {
    it('says it could not be loaded when the refusal is not about access', async () => {
      mockApi({ listStatus: 500 });
      render(<AdminNarrativePromptsPage />);
      expect(await screen.findByText('Could not load the narrative prompt library.')).toBeInTheDocument();
    });

    /**
     * Sort order is sparse and hand-entered, so two sections sharing one is a
     * matter of time. The order they then take has to be stable, or two loads
     * of the same library list the report's sections differently.
     */
    it('breaks a tie on sort order by section key, not by arrival', async () => {
      mockApi({
        prompts: [
          base({ id: 'b', section_key: 'zeta_section', label: 'Zeta', sort_order: 10 }),
          base({ id: 'a', section_key: 'alpha_section', label: 'Alpha', sort_order: 10 }),
        ],
      });
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Alpha');

      const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
      expect(headings).toEqual(['Alpha', 'Zeta']);
    });

    it('counts a report type’s overrides in the plural when there are several', async () => {
      mockApi({
        prompts: [
          base(),
          base({ id: 'q1', kind: 'qsbs', section_key: 'a', label: 'Q1' }),
          base({ id: 'q2', kind: 'qsbs', section_key: 'b', label: 'Q2' }),
        ],
      });
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');

      expect(screen.getByRole('option', { name: /QSBS — 2 overrides/i })).toBeInTheDocument();
    });

    it('counts what a kind with no rows of its own inherits, in both places it says so', async () => {
      mockApi({ prompts: [base(), EDITED] });
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');
      await userEvent.selectOptions(screen.getByRole('combobox'), 'qsbs');

      // The empty state names the number rather than leaving "drafted entirely
      // from the base library" as an unquantified claim.
      expect(await screen.findByText(/all 2 sections/)).toBeInTheDocument();
    });

    it('counts a single inherited section in the singular', async () => {
      mockApi({
        prompts: [base(), base({ id: 'q1', kind: 'qsbs', section_key: 'x', label: 'Q1' })],
      });
      render(<AdminNarrativePromptsPage />);
      await screen.findByText('Executive Summary');
      await userEvent.selectOptions(screen.getByRole('combobox'), 'qsbs');

      expect(
        await screen.findByText(/Plus 1 section inherited unchanged from the base library/),
      ).toBeInTheDocument();
    });
  });
});
