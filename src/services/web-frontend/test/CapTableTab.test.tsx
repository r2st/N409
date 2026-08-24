import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { CapTableTab } from '../src/pages/valuation/CapTableTab';
import type { User, Valuation } from '../src/lib/types';

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const OPS_USER = { id: 'u-ops', email: 'ops@example.com', roles: ['admin'] } as unknown as User;
const CLIENT_USER = { id: 'u-cl', email: 'client@example.com', roles: ['valuation_user'] } as unknown as User;

/**
 * The cap table is the input the whole waterfall stands on: every preference,
 * every conversion and the fully-diluted denominator come from here, and it
 * arrives as somebody's spreadsheet export. The tab had no tests at all, so
 * none of the things that decide whether a bad import is caught — the error/
 * warning ordering a reviewer reconciles against the open workbook, the save
 * button that must not appear while errors block, the rejected-save payload
 * that says *which rows* failed — were pinned anywhere.
 */

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'in_progress',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const ENTRIES = [
  {
    security_class: 'Common Stock',
    class_type: 'common',
    shares: 8_000_000,
    price_per_share: 0.1,
    invested_amount: null,
    liquidation_multiple: null,
    seniority: null,
    conversion_ratio: null,
  },
  {
    security_class: 'Series A Preferred',
    class_type: 'preferred',
    shares: 4_000_000,
    price_per_share: 1.25,
    invested_amount: 5_000_000,
    liquidation_multiple: 1,
    seniority: 1,
    conversion_ratio: 1,
  },
];

const SUMMARY = {
  total_shares: 12_000_000,
  common_shares: 8_000_000,
  preferred_shares: 4_000_000,
  option_shares: 1_500_000,
  warrant_shares: 0,
  fully_diluted_shares: 13_500_000,
  total_preference_stack: 5_000_000,
  class_count: 2,
};

const VALID = { valid: true, issues: [], summary: SUMMARY };

const STORED = {
  source_format: 'carta',
  entries: ENTRIES,
  validation: VALID,
  updated_at: '2026-08-01T00:00:00.000Z',
};

const FORMATS = [
  { key: 'generic', label: 'Generic', mapping: { security_class: 'class', shares: 'shares' } },
  {
    key: 'carta',
    label: 'Carta export',
    mapping: { security_class: 'Security', shares: 'Quantity', price_per_share: 'Price' },
  },
];

/** Every field CapTableGraph reads, so a fixture states only what it varies. */
const GRAPH_NODE = {
  id: 'n',
  kind: 'share_class' as const,
  label: 'Class',
  rank: 0,
  shares: 8_000_000,
  // The basis `ownership` is struck on. Every node the server builds carries
  // it — as a number or an explicit null — so a fixture without it was
  // describing a payload this app is never sent.
  as_converted_shares: 8_000_000,
  ownership: 0.6,
  class_type: 'common',
  seniority: null,
  liquidation_preference: null,
  price_per_share: 0.1,
  invested_amount: null,
  conversion_ratio: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Routes fetches by path so a test states only the responses it cares about.
 * Anything unrouted resolves as an empty 200 rather than rejecting, so an
 * incidental call (the formats list, the graph) never fails a test about
 * something else.
 */
function mockApi(routes: Array<[RegExp, () => Response]>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [pattern, respond] of routes) if (pattern.test(url)) return respond();
    return json({});
  });
}

const capTable = (body: unknown) => [/\/cap-table$/, () => json(body)] as [RegExp, () => Response];
const formats = () => [/\/cap-table\/formats/, () => json({ formats: FORMATS })] as [RegExp, () => Response];

/** The upload response shape, restated here because the tab keeps it private. */
interface UploadedSheet {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  lines: number[];
}
interface Upload {
  filename: string;
  source: 'xlsx' | 'csv';
  truncated: boolean;
  sheets: UploadedSheet[];
}

async function openImporter() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /import/i }));
  return user;
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/cap-table']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/cap-table" element={<CapTableTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('CapTableTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUser = OPS_USER;
  });

  describe('the stored table', () => {
    it('reports the three figures the waterfall is built on', async () => {
      mockApi([capTable({ cap_table: STORED, can_edit: true }), formats()]);
      renderTab();
      await screen.findByText('Current cap table');
      // Fully diluted is the denominator of the per-share result, the pool is
      // the part of it that is not yet issued, and the preference stack is what
      // comes off the top before common sees anything. Read through the tile
      // label rather than by value: Series A's invested amount is the same
      // number as the stack, and a test that cannot tell them apart would pass
      // on a page that showed the wrong one twice.
      const tile = (label: string) => screen.getByText(label).parentElement!;
      expect(tile('Fully diluted')).toHaveTextContent('13,500,000');
      expect(tile('Option pool')).toHaveTextContent('1,500,000');
      expect(tile('Preference stack')).toHaveTextContent('$5,000,000.00');
    });

    it('lists each class with its price and preference', async () => {
      mockApi([capTable({ cap_table: STORED, can_edit: true }), formats()]);
      renderTab();
      const row = (await screen.findByText('Series A Preferred')).closest('tr')!;
      expect(within(row).getByText('4,000,000')).toBeInTheDocument();
      expect(within(row).getByText('$1.25')).toBeInTheDocument();
      expect(within(row).getByText('1×')).toBeInTheDocument();
    });

    it('dashes the columns a class does not carry rather than showing zero', async () => {
      // Common has no invested amount and no liquidation multiple. Rendering
      // those as 0 would read as "no preference stack", which is a different
      // claim from "not applicable to common".
      mockApi([capTable({ cap_table: STORED, can_edit: true }), formats()]);
      renderTab();
      const row = (await screen.findByText('Common Stock')).closest('tr')!;
      expect(within(row).getAllByText('—')).toHaveLength(2);
    });

    it('names the source format and class count', async () => {
      mockApi([capTable({ cap_table: STORED, can_edit: true }), formats()]);
      renderTab();
      await screen.findByText(/carta · 2 classes/);
    });
  });

  describe('validation issues', () => {
    const ISSUES = {
      valid: false,
      summary: SUMMARY,
      issues: [
        { severity: 'warning' as const, code: 'no_option_pool', message: 'No option pool found' },
        { severity: 'error' as const, code: 'bad_shares', message: 'Shares must be positive', row: 9 },
        { severity: 'warning' as const, code: 'odd_price', message: 'Price looks low', row: 4 },
        { severity: 'error' as const, code: 'empty_class', message: 'Security class is blank', row: 3 },
      ],
    };

    it('counts the errors that block the import, and the warnings separately', async () => {
      mockApi([capTable({ cap_table: { ...STORED, validation: ISSUES }, can_edit: true }), formats()]);
      renderTab();
      await screen.findByText(/2 error\(s\) block this import · 2 warning\(s\)/);
    });

    it('puts every error above every warning, each in file order', async () => {
      // The reviewer reads this list with the workbook open beside it. Errors
      // stay together because they are what blocks the save; within a severity
      // the order is the order of the rows on screen, not the order the
      // validator happened to emit its checks in.
      mockApi([capTable({ cap_table: { ...STORED, validation: ISSUES }, can_edit: true }), formats()]);
      renderTab();
      await screen.findByText('Security class is blank');
      const items = screen.getAllByRole('listitem').map((li) => li.textContent);
      expect(items).toEqual([
        '3Security class is blank',
        '9Shares must be positive',
        '4Price looks low',
        // The bullet stands in for the row number a table-level issue has not got,
        // so the message column still lines up with the ones above it.
        '•No option pool found',
      ]);
    });

    it('sorts a table-level issue last, where it reads as a summary', async () => {
      mockApi([capTable({ cap_table: { ...STORED, validation: ISSUES }, can_edit: true }), formats()]);
      renderTab();
      await screen.findByText('No option pool found');
      // It has no row, so there is nothing to go and look at — it belongs after
      // the issues that name a line.
      const last = screen.getAllByRole('listitem').at(-1)!;
      expect(last).toHaveTextContent('No option pool found');
      expect(within(last).queryByLabelText(/^Row /)).toBeNull();
    });

    it('gives each row number its own scannable element', async () => {
      mockApi([capTable({ cap_table: { ...STORED, validation: ISSUES }, can_edit: true }), formats()]);
      renderTab();
      expect(await screen.findByLabelText('Row 3')).toHaveTextContent('3');
      expect(screen.getByLabelText('Row 9')).toHaveTextContent('9');
    });

    it('says so plainly when the table is valid', async () => {
      mockApi([capTable({ cap_table: STORED, can_edit: true }), formats()]);
      renderTab();
      await screen.findByText('Cap table is valid');
      expect(screen.queryByRole('listitem')).toBeNull();
    });
  });

  describe('permissions and empty state', () => {
    it('invites an editor to import when there is nothing stored', async () => {
      mockApi([capTable({ cap_table: null, can_edit: true }), formats()]);
      renderTab();
      await screen.findByText('No cap table imported yet');
      expect(screen.getByText(/Upload an Excel or CSV export/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import cap table' })).toBeInTheDocument();
    });

    it('tells a reader without edit rights to wait, and offers no import', async () => {
      mockApi([capTable({ cap_table: null, can_edit: false }), formats()]);
      renderTab();
      await screen.findByText(/The cap table will appear here once imported./);
      expect(screen.queryByRole('button', { name: /import/i })).toBeNull();
    });

    it('offers re-import, not import, once a table is stored', async () => {
      mockApi([capTable({ cap_table: STORED, can_edit: true }), formats()]);
      renderTab();
      expect(await screen.findByRole('button', { name: 'Re-import' })).toBeInTheDocument();
    });

    it('reports a failed load instead of rendering an empty table', async () => {
      mockApi([
        [/\/cap-table$/, () => json({ status: 500, detail: 'Cap table service is down' }, 500)],
        formats(),
      ]);
      renderTab();
      await screen.findByText('Cap table service is down');
    });
  });

  describe('the importer', () => {
    it('derives the column mapping choices from the pasted CSV header', async () => {
      mockApi([capTable({ cap_table: null, can_edit: true }), formats()]);
      renderTab();
      const user = await openImporter();
      await user.type(screen.getByRole('textbox'), 'class,shares,price{enter}Common Stock,8000000,0.10');
      const select = await screen.findByLabelText('Security class *');
      expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
        '—',
        'class',
        'shares',
        'price',
      ]);
    });

    it('reads a quoted header field as one column, commas and all', async () => {
      // A Carta export writes `"Shares, fully diluted"`. Split naively it
      // becomes two columns, and the mapping offers neither of them.
      mockApi([capTable({ cap_table: null, can_edit: true }), formats()]);
      renderTab();
      const user = await openImporter();
      await user.type(screen.getByRole('textbox'), 'class,"Shares, fully diluted",price');
      const select = await screen.findByLabelText('Shares *');
      expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toContain(
        'Shares, fully diluted',
      );
    });

    it('offers no mapping at all until there is a header to map', async () => {
      mockApi([capTable({ cap_table: null, can_edit: true }), formats()]);
      renderTab();
      await openImporter();
      expect(screen.queryByText('Column mapping')).toBeNull();
    });

    it('cannot preview an empty paste', async () => {
      mockApi([capTable({ cap_table: null, can_edit: true }), formats()]);
      renderTab();
      await openImporter();
      expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    });

    it('shows the preview validation and only then offers to save', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        [/\/cap-table\/preview/, () => json({ entries: ENTRIES, validation: VALID })],
      ]);
      renderTab();
      const user = await openImporter();
      await user.type(screen.getByRole('textbox'), 'class,shares');
      expect(screen.queryByRole('button', { name: 'Save cap table' })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Preview' }));
      await screen.findByText('Cap table is valid');
      expect(screen.getByRole('button', { name: 'Save cap table' })).toBeInTheDocument();
    });

    it('withholds save while an error blocks the import', async () => {
      const blocked = {
        valid: false,
        summary: SUMMARY,
        issues: [{ severity: 'error' as const, code: 'bad', message: 'Shares must be positive', row: 2 }],
      };
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        [/\/cap-table\/preview/, () => json({ entries: [], validation: blocked })],
      ]);
      renderTab();
      const user = await openImporter();
      await user.type(screen.getByRole('textbox'), 'class,shares');
      await user.click(screen.getByRole('button', { name: 'Preview' }));
      await screen.findByText(/1 error\(s\) block this import/);
      expect(screen.queryByRole('button', { name: 'Save cap table' })).toBeNull();
    });

    it('reports a failed preview without clearing what was typed', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        [/\/cap-table\/preview/, () => json({ status: 400, detail: 'Mapping is incomplete' }, 400)],
      ]);
      renderTab();
      const user = await openImporter();
      await user.type(screen.getByRole('textbox'), 'class,shares');
      await user.click(screen.getByRole('button', { name: 'Preview' }));
      await screen.findByText('Mapping is incomplete');
      expect(screen.getByRole('textbox')).toHaveValue('class,shares');
    });

    it('shows which rows a rejected save failed on, not just that it failed', async () => {
      // The save endpoint re-validates, and can refuse an import the preview
      // accepted. Returning only "could not save" would send the user back to
      // the spreadsheet with nothing to look for.
      const rejected = {
        valid: false,
        summary: SUMMARY,
        issues: [{ severity: 'error' as const, code: 'dupe', message: 'Duplicate security class', row: 7 }],
      };
      mockApi([
        [/\/cap-table\/preview/, () => json({ entries: ENTRIES, validation: VALID })],
        [/\/cap-table$/, () => json({ cap_table: null, can_edit: true })],
        formats(),
      ]);
      renderTab();
      const user = await openImporter();
      await user.type(screen.getByRole('textbox'), 'class,shares');
      await user.click(screen.getByRole('button', { name: 'Preview' }));
      await screen.findByText('Cap table is valid');

      // The PUT is the same path as the GET, so re-point it once the preview
      // has been taken.
      mockApi([
        [/\/cap-table\/preview/, () => json({ entries: ENTRIES, validation: VALID })],
        [/\/cap-table$/, () => json({ status: 422, detail: 'Import rejected', validation: rejected }, 422)],
        formats(),
      ]);
      await user.click(screen.getByRole('button', { name: 'Save cap table' }));
      await screen.findByText('Duplicate security class');
      expect(screen.getByLabelText('Row 7')).toBeInTheDocument();
      expect(screen.getByText('Import rejected')).toBeInTheDocument();
    });

    it('closes the importer and reloads the stored table on a successful save', async () => {
      let stored: unknown = null;
      mockApi([
        [/\/cap-table\/preview/, () => json({ entries: ENTRIES, validation: VALID })],
        [
          /\/cap-table$/,
          () => {
            const body = json({ cap_table: stored, can_edit: true });
            stored = STORED; // the PUT lands, so the next GET sees it
            return body;
          },
        ],
        formats(),
      ]);
      renderTab();
      const user = await openImporter();
      await user.type(screen.getByRole('textbox'), 'class,shares');
      await user.click(screen.getByRole('button', { name: 'Preview' }));
      await user.click(await screen.findByRole('button', { name: 'Save cap table' }));

      await screen.findByText('Current cap table');
      expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
    });

    /**
     * Optimistic locking, from the tab's side (migration 0162).
     *
     * The guard is opt-in over HTTP, so it only protects anything if this tab
     * actually sends the version it loaded. An import replaces the table
     * wholesale — a save built on a stale read discards whatever landed since,
     * which for this row means the whole capitalization and every figure drawn
     * from it.
     */
    it('sends the loaded version as If-Match on the import', async () => {
      const fetchSpy = mockApi([
        [/\/cap-table\/preview/, () => json({ entries: ENTRIES, validation: VALID })],
        capTable({ cap_table: { ...STORED, version: 7 }, can_edit: true }),
        formats(),
      ]);
      renderTab();
      const user = await openImporter();
      await user.type(screen.getByRole('textbox'), 'class,shares');
      await user.click(screen.getByRole('button', { name: 'Preview' }));
      await user.click(await screen.findByRole('button', { name: 'Save cap table' }));

      await waitFor(() => {
        const put = fetchSpy.mock.calls.find(
          ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
        );
        expect(put, 'no PUT was issued').toBeDefined();
        const headers = new Headers((put![1] as RequestInit).headers);
        expect(headers.get('if-match')).toBe('"7"');
      });
    });

    /**
     * A server with no version — an older build, or a table this tab loaded
     * before 0162 shipped — must not turn into `If-Match: "undefined"`, which
     * the server refuses as malformed. Sending nothing falls back to
     * last-write-wins, which is what the tab did before and is strictly better
     * than a save that cannot succeed.
     */
    it('omits If-Match when the server reports no version', async () => {
      const fetchSpy = mockApi([
        [/\/cap-table\/preview/, () => json({ entries: ENTRIES, validation: VALID })],
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      const user = await openImporter();
      await user.type(screen.getByRole('textbox'), 'class,shares');
      await user.click(screen.getByRole('button', { name: 'Preview' }));
      await user.click(await screen.findByRole('button', { name: 'Save cap table' }));

      await waitFor(() => {
        const put = fetchSpy.mock.calls.find(
          ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
        );
        expect(put, 'no PUT was issued').toBeDefined();
        expect(new Headers((put![1] as RequestInit).headers).has('if-match')).toBe(false);
      });
    });

    /**
     * A 409 is an out-of-date tab, not a failed import: the table is reloaded so
     * the user reapplies onto what actually landed. Reloading is the point —
     * leaving the stale copy on screen invites the same losing import again.
     */
    it('reloads and explains itself when someone else saved first', async () => {
      let conflicted = false;
      mockApi([
        [/\/cap-table\/preview/, () => json({ entries: ENTRIES, validation: VALID })],
        [
          /\/cap-table$/,
          () => {
            if (!conflicted) {
              conflicted = true;
              return json({ cap_table: { ...STORED, version: 3 }, can_edit: true });
            }
            return json({ cap_table: { ...STORED, version: 4 }, can_edit: true });
          },
        ],
        formats(),
      ]);
      renderTab();
      const user = await openImporter();
      await user.type(screen.getByRole('textbox'), 'class,shares');
      await user.click(screen.getByRole('button', { name: 'Preview' }));

      // Re-point the PUT at the conflict once the preview has been taken.
      mockApi([
        [/\/cap-table\/preview/, () => json({ entries: ENTRIES, validation: VALID })],
        [
          /\/cap-table$/,
          () =>
            json(
              {
                status: 409,
                detail:
                  'This cap table was changed by someone else (expected version 3, now 4). Reload and reapply your changes.',
              },
              409,
            ),
        ],
        formats(),
      ]);
      await user.click(await screen.findByRole('button', { name: 'Save cap table' }));

      // The server's own wording, so the user is told which version they lost
      // to rather than a generic failure.
      expect(await screen.findByText(/changed by someone else/i)).toBeInTheDocument();
      // Not the validation branch: a 409 carries no `validation`, and falling
      // through to it would blank the preview and say nothing useful.
      expect(screen.queryByText('Import rejected')).toBeNull();
    });

    it('discards the draft when the import is cancelled', async () => {
      mockApi([capTable({ cap_table: null, can_edit: true }), formats()]);
      renderTab();
      const user = await openImporter();
      await user.type(screen.getByRole('textbox'), 'class,shares');
      await user.click(screen.getByRole('button', { name: 'Cancel import' }));
      await user.click(screen.getByRole('button', { name: 'Import cap table' }));
      // Re-opening onto the previous attempt's half-finished mapping is how a
      // user saves the file they thought they had abandoned.
      expect(screen.getByRole('textbox')).toHaveValue('');
    });

    it('lists the source formats the server offers', async () => {
      mockApi([capTable({ cap_table: null, can_edit: true }), formats()]);
      renderTab();
      await openImporter();
      const select = await screen.findByLabelText('Source format');
      expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
        'Generic',
        'Carta export',
      ]);
    });

    it('says the presets are missing rather than offering a blank format', async () => {
      /*
       * The presets do two jobs and losing them silently cost both: the select
       * rendered blank while `format` stayed at its 'generic' default and was
       * submitted anyway, and every column mapping fell back to "—" — so a form
       * that normally arrives mostly filled in arrived empty, with nothing to
       * distinguish that from a file with unfamiliar headers.
       */
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        [/\/cap-table\/formats/, () => json({ detail: 'nope' }, 503)],
      ]);
      renderTab();
      await openImporter();

      const select = await screen.findByLabelText('Source format');
      expect(select).toBeDisabled();
      expect(select).toHaveValue('generic');
      await screen.findByText(/format presets could not be loaded/);
    });

    it('says nothing of the sort when the presets load', async () => {
      // The other half — the warning must be earned.
      mockApi([capTable({ cap_table: null, can_edit: true }), formats()]);
      renderTab();
      await openImporter();

      expect(await screen.findByLabelText('Source format')).not.toBeDisabled();
      expect(screen.queryByText(/could not be loaded/)).toBeNull();
    });

    it('preselects the columns a format preset names, when the sheet has them', async () => {
      mockApi([capTable({ cap_table: null, can_edit: true }), formats()]);
      renderTab();
      const user = await openImporter();
      await user.selectOptions(await screen.findByLabelText('Source format'), 'carta');
      await user.type(screen.getByRole('textbox'), 'Security,Quantity,Price');
      expect(await screen.findByLabelText('Security class *')).toHaveValue('Security');
      expect(screen.getByLabelText('Shares *')).toHaveValue('Quantity');
    });

    it('leaves a preset column unselected when the sheet does not have it', async () => {
      // Carta's own export renamed a column, or the file is a hand-edited
      // derivative. Selecting a column that is not there would map real data to
      // nothing and report it as a mapped import.
      mockApi([capTable({ cap_table: null, can_edit: true }), formats()]);
      renderTab();
      const user = await openImporter();
      await user.selectOptions(await screen.findByLabelText('Source format'), 'carta');
      await user.type(screen.getByRole('textbox'), 'class,shares');
      expect(await screen.findByLabelText('Security class *')).toHaveValue('');
    });
  });

  describe('uploading a workbook', () => {
    const sheet = (over: Partial<UploadedSheet> = {}): UploadedSheet => ({
      name: 'Sheet1',
      headers: ['Security', 'Quantity'],
      rows: [{ Security: 'Common Stock', Quantity: '8000000' }],
      lines: [2],
      ...over,
    });
    const uploaded = (over: Partial<Upload> = {}): Upload => ({
      filename: 'captable.xlsx',
      source: 'xlsx',
      truncated: false,
      sheets: [sheet()],
      ...over,
    });
    const uploadRoute = (respond: () => Response) =>
      [/\/cap-table\/upload/, respond] as [RegExp, () => Response];

    async function uploadFile(user: ReturnType<typeof userEvent.setup>, name = 'captable.xlsx') {
      const input = screen.getByLabelText(/Upload Excel or CSV/);
      await user.upload(input, new File(['binary'], name));
      return input as HTMLInputElement;
    }

    it('names the uploaded file and its row count, and maps from the sheet header', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        uploadRoute(() => json(uploaded())),
      ]);
      renderTab();
      const user = await openImporter();
      await uploadFile(user);

      expect(await screen.findByText('captable.xlsx')).toBeInTheDocument();
      expect(screen.getByText(/Excel workbook · 1 rows/)).toBeInTheDocument();
      // The mapping now comes from the server's parse, not from the textarea,
      // which the upload replaces entirely.
      const select = await screen.findByLabelText('Security class *');
      expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
        '—',
        'Security',
        'Quantity',
      ]);
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    /**
     * The parsed rows go to the server, not the raw file: an .xlsx has no CSV
     * text to send, and the source lines are what let a validation error cite
     * the row the reader sees in Excel.
     */
    it('sends the parsed rows and their source lines, not raw text', async () => {
      let previewBody: Record<string, unknown> | null = null;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/\/cap-table\/upload/.test(url)) return json(uploaded());
        if (/\/cap-table\/preview/.test(url)) {
          previewBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json({ entries: ENTRIES, validation: VALID });
        }
        if (/\/cap-table\/formats/.test(url)) return json({ formats: FORMATS });
        return json({ cap_table: null, can_edit: true });
      });
      renderTab();
      const user = await openImporter();
      await uploadFile(user);
      await screen.findByText('captable.xlsx');
      await user.click(screen.getByRole('button', { name: 'Preview' }));

      await waitFor(() => expect(previewBody).not.toBeNull());
      expect(previewBody).toEqual({
        format: 'generic',
        rows: [{ Security: 'Common Stock', Quantity: '8000000' }],
        source_lines: [2],
        mapping: {},
      });
      expect(previewBody).not.toHaveProperty('csv');
    });

    it('lands on the sheet that looks like the cap table, not the first tab', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        uploadRoute(() =>
          json(
            uploaded({
              sheets: [
                sheet({ name: 'Instructions', rows: [{ Security: 'read me', Quantity: '' }] }),
                sheet({ name: 'Cap Table', rows: [{ Security: 'Common Stock', Quantity: '8000000' }] }),
              ],
            }),
          ),
        ),
      ]);
      renderTab();
      const user = await openImporter();
      await uploadFile(user);
      expect(await screen.findByLabelText('Sheet')).toHaveValue('1');
    });

    it('falls back to the first sheet with rows when no tab is named for equity', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        uploadRoute(() =>
          json(
            uploaded({
              sheets: [
                sheet({ name: 'Cover', rows: [], lines: [] }),
                sheet({ name: 'Data', rows: [{ Security: 'Common Stock', Quantity: '8000000' }] }),
              ],
            }),
          ),
        ),
      ]);
      renderTab();
      const user = await openImporter();
      await uploadFile(user);
      expect(await screen.findByLabelText('Sheet')).toHaveValue('1');
    });

    /**
     * Neither search matches, and `findIndex(...) || 0` left the index at -1:
     * the picker showed a value no option carried and the "no data rows"
     * hint — the one piece of advice this workbook needs — never rendered.
     */
    it('lands on the first sheet, and says it is empty, when no sheet has rows', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        uploadRoute(() =>
          json(
            uploaded({
              sheets: [
                sheet({ name: 'Cover', rows: [], lines: [] }),
                sheet({ name: 'Notes', rows: [], lines: [] }),
              ],
            }),
          ),
        ),
      ]);
      renderTab();
      const user = await openImporter();
      await uploadFile(user);

      expect(await screen.findByLabelText('Sheet')).toHaveValue('0');
      expect(screen.getByText(/This sheet has no data rows/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    });

    it('offers no sheet picker for a single-sheet file', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        uploadRoute(() => json(uploaded({ source: 'csv', filename: 'export.csv' }))),
      ]);
      renderTab();
      const user = await openImporter();
      await uploadFile(user, 'export.csv');
      await screen.findByText('export.csv');
      expect(screen.getByText(/CSV · 1 rows/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Sheet')).toBeNull();
    });

    it('switches sheets and drops the mapping taken from the previous one', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        uploadRoute(() =>
          json(
            uploaded({
              sheets: [
                sheet({ name: 'Cap Table', headers: ['Security', 'Quantity'] }),
                sheet({ name: 'Options', headers: ['Holder', 'Granted'] }),
              ],
            }),
          ),
        ),
      ]);
      renderTab();
      const user = await openImporter();
      await uploadFile(user);
      await user.selectOptions(await screen.findByLabelText('Security class *'), 'Security');
      expect(screen.getByLabelText('Security class *')).toHaveValue('Security');

      await user.selectOptions(screen.getByLabelText('Sheet'), '1');
      // Carrying "Security" across would map a column the new sheet has not got.
      expect(await screen.findByLabelText('Security class *')).toHaveValue('');
      expect([...screen.getByLabelText('Shares *').querySelectorAll('option')].map((o) => o.value)).toEqual([
        '',
        'Holder',
        'Granted',
      ]);
    });

    it('warns that a long workbook was cut short rather than importing part of it silently', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        uploadRoute(() => json(uploaded({ truncated: true }))),
      ]);
      renderTab();
      const user = await openImporter();
      await uploadFile(user);
      expect(await screen.findByText(/Only the first 2,000 rows were read/)).toBeInTheDocument();
    });

    it('removes the upload and returns to the paste box', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        uploadRoute(() => json(uploaded())),
      ]);
      renderTab();
      const user = await openImporter();
      await uploadFile(user);
      await user.click(await screen.findByRole('button', { name: 'Remove' }));

      expect(screen.getByRole('textbox')).toHaveValue('');
      expect(screen.queryByText('captable.xlsx')).toBeNull();
    });

    it('reports a file the server could not read, and keeps the paste box usable', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        uploadRoute(() => json({ status: 415, detail: 'That file is not a readable workbook' }, 415)),
      ]);
      renderTab();
      const user = await openImporter();
      await uploadFile(user, 'captable.xlsx');

      expect(await screen.findByText('That file is not a readable workbook')).toBeInTheDocument();
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    /**
     * The browser fires no change event when the same file is picked twice in a
     * row, so a rejected upload could not simply be retried after fixing the
     * file. Clearing the input's value is what makes the second pick fire.
     */
    it('clears the file input so the same file can be re-picked after a failure', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        uploadRoute(() => json({ status: 500, detail: 'Parser crashed' }, 500)),
      ]);
      renderTab();
      const user = await openImporter();
      const input = await uploadFile(user);
      await screen.findByText('Parser crashed');
      expect(input.value).toBe('');
    });

    it('cancelling the import discards the uploaded workbook too', async () => {
      mockApi([
        capTable({ cap_table: null, can_edit: true }),
        formats(),
        uploadRoute(() => json(uploaded())),
      ]);
      renderTab();
      const user = await openImporter();
      await uploadFile(user);
      await screen.findByText('captable.xlsx');

      await user.click(screen.getByRole('button', { name: 'Cancel import' }));
      await user.click(screen.getByRole('button', { name: 'Import cap table' }));
      expect(screen.queryByText('captable.xlsx')).toBeNull();
      expect(screen.getByRole('textbox')).toHaveValue('');
    });
  });

  describe('the structure explorer', () => {
    it('stays collapsed, and fetches nothing, until asked', async () => {
      const fetchSpy = mockApi([capTable({ cap_table: STORED, can_edit: true }), formats()]);
      renderTab();
      await screen.findByText('Structure explorer');
      expect(fetchSpy.mock.calls.map(String).some((u) => u.includes('cap-table/graph'))).toBe(false);
    });

    it('draws the graph once opened', async () => {
      mockApi([
        [
          /\/cap-table\/graph/,
          () =>
            json({
              graph: {
                nodes: [
                  { ...GRAPH_NODE, id: 'common', label: 'Common Stock', class_type: 'common' },
                  {
                    ...GRAPH_NODE,
                    id: 'a',
                    label: 'Series A Preferred',
                    class_type: 'preferred',
                    rank: 1,
                    seniority: 1,
                  },
                ],
                edges: [{ from: 'a', to: 'common', kind: 'converts_to', label: '1:1' }],
                issues: [],
              },
            }),
        ],
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Show' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Hide' })).toBeInTheDocument());
    });

    it('draws a node whose as-converted count is missing rather than blanking the tab', async () => {
      /*
       * `as_converted_shares` arrived with 50061df. A response serialised
       * before it — one still in a cache, or a client pinned to the older
       * contract — has no key there, and `undefined` is not `null`: the strict
       * check called the node *converting* exactly when it had no as-converted
       * figure, then asserted non-null and handed `undefined` to
       * `toLocaleString`. That throws during render, and React does not contain
       * it — the whole Cap table tab came out as an empty div.
       *
       * The assertion is therefore that the page is still there, with the
       * outstanding count drawn, which is what a class converting 1:1 shows
       * anyway.
       */
      const { as_converted_shares: _omitted, ...WITHOUT } = GRAPH_NODE;
      mockApi([
        [
          /\/cap-table\/graph/,
          () =>
            json({
              graph: {
                nodes: [{ ...WITHOUT, id: 'common', label: 'Common Stock' }],
                edges: [],
                issues: [],
              },
            }),
        ],
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Show' }));

      expect(await screen.findByRole('button', { name: 'Hide' })).toBeInTheDocument();
      // The node's own badge — the outstanding count, drawn in the SVG. The
      // label is not asserted on: "Common Stock" is a class name and appears in
      // the cap table below as well, so it cannot tell the graph from the grid.
      expect(screen.getByText('8,000,000 sh')).toBeInTheDocument();
    });

    it('says the graph could not be built rather than spinning forever', async () => {
      mockApi([
        [/\/cap-table\/graph/, () => json({ status: 500, detail: 'boom' }, 500)],
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Show' }));
      await screen.findByText('Could not build the structure graph.');
    });

    it('is absent entirely when there is no table to draw', async () => {
      mockApi([capTable({ cap_table: null, can_edit: true }), formats()]);
      renderTab();
      await screen.findByText('No cap table imported yet');
      expect(screen.queryByText('Structure explorer')).toBeNull();
    });
  });

  /**
   * The anonymizer (409.ai parity gap #22). The redaction is the AI service's
   * and is proved there; what these pin is the operator's side of it — that a
   * client cannot reach it, that the request carries what was ticked and typed,
   * and that the result reports what it struck in words rather than as the API's
   * category keys.
   */
  describe('the anonymizer', () => {
    const DOCS = [
      { id: 'doc-1', filename: 'Acme Cap Table.csv' },
      { id: 'doc-2', filename: 'Board consent.pdf' },
    ];
    const documents = () => [/\/documents$/, () => json({ documents: DOCS })] as [RegExp, () => Response];

    const RESULT = {
      text: '[NAME],Common,2500000',
      documents: [],
      anonymization: { applied: true, enforced: false, redacted: { names: 1, emails: 2 } },
      known_entities: { companies: 2, people: 1 },
    };

    const open = async () => {
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Show anonymizer' }));
      return user;
    };

    it('is not offered to a client', async () => {
      mockUser = CLIENT_USER;
      mockApi([capTable({ cap_table: STORED, can_edit: false }), formats()]);
      renderTab();
      await screen.findByText('Current cap table');
      expect(screen.queryByText('Anonymize')).toBeNull();
    });

    it('sends the ticked documents and the typed names, split on lines and commas', async () => {
      const fetchMock = mockApi([
        [/\/ai\/anonymize$/, () => json(RESULT)],
        documents(),
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      const user = await open();

      await user.click(await screen.findByLabelText('Acme Cap Table.csv'));
      await user.type(screen.getByLabelText(/other names to strike/i), 'Ada Lovelace\nGrace Hopper');
      await user.click(screen.getByRole('button', { name: 'Anonymize' }));

      await screen.findByTestId('anonymize-summary');
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/ai/anonymize'))!;
      const body = JSON.parse(String((call[1] as RequestInit).body));
      expect(body.document_ids).toEqual(['doc-1']);
      expect(body.known_people).toEqual(['Ada Lovelace', 'Grace Hopper']);
    });

    it('says the document list failed rather than showing the nothing it shows for none', async () => {
      /*
       * `.catch(() => setDocuments([]))` rendered the same nothing an
       * engagement with no uploads renders — the Documents fieldset is behind
       * `documents.length > 0`, so the section was simply absent and the
       * analyst's reasonable conclusion, "there is nothing uploaded to
       * anonymize", was the wrong one.
       */
      mockApi([
        [/\/documents$/, () => json({ detail: 'nope' }, 503)],
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      await open();

      await screen.findByText(/uploaded documents could not be listed/);
    });

    it('offers no such note when the engagement genuinely has no uploads', async () => {
      mockApi([
        [/\/documents$/, () => json({ documents: [] })],
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      await open();

      await screen.findByLabelText(/other names to strike/i);
      expect(screen.queryByText(/could not be listed/)).toBeNull();
    });

    it('will not run with nothing selected and nothing pasted', async () => {
      mockApi([documents(), capTable({ cap_table: STORED, can_edit: true }), formats()]);
      renderTab();
      await open();
      expect(screen.getByRole('button', { name: 'Anonymize' })).toBeDisabled();
    });

    it('says what it struck in words, and how many entities it was matching against', async () => {
      mockApi([
        [/\/ai\/anonymize$/, () => json(RESULT)],
        documents(),
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      const user = await open();
      await user.type(screen.getByLabelText(/paste a cap table/i), 'Ada Lovelace,Common,2500000');
      await user.click(screen.getByRole('button', { name: 'Anonymize' }));

      const summary = await screen.findByTestId('anonymize-summary');
      expect(summary).toHaveTextContent('1 person name');
      expect(summary).toHaveTextContent('2 email addresses');
      // "Nothing was struck" means one thing against a list of three entities
      // and quite another against an empty one, so the count is always stated.
      expect(summary).toHaveTextContent('2 known companies');
      expect(summary).toHaveTextContent('1 known person');
      expect(screen.getByText('[NAME],Common,2500000')).toBeInTheDocument();
    });

    it('distinguishes a clean sheet from an unmatched one', async () => {
      mockApi([
        [
          /\/ai\/anonymize$/,
          () =>
            json({
              ...RESULT,
              text: 'nothing identifying here',
              anonymization: { applied: true, enforced: false, redacted: {} },
            }),
        ],
        documents(),
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      const user = await open();
      await user.type(screen.getByLabelText(/paste a cap table/i), 'nothing identifying here');
      await user.click(screen.getByRole('button', { name: 'Anonymize' }));
      expect(await screen.findByTestId('anonymize-summary')).toHaveTextContent('Nothing was struck.');
    });

    it('shows both filenames for a redacted document', async () => {
      mockApi([
        [
          /\/ai\/anonymize$/,
          () =>
            json({
              ...RESULT,
              text: '',
              documents: [
                {
                  id: 'doc-1',
                  original_filename: 'Acme Cap Table.csv',
                  filename: '[COMPANY] Cap Table.csv',
                  text: '[NAME],Common,2500000',
                },
              ],
            }),
        ],
        documents(),
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      const user = await open();
      await user.click(await screen.findByLabelText('Acme Cap Table.csv'));
      await user.click(screen.getByRole('button', { name: 'Anonymize' }));

      // The redacted name is what may be forwarded; the original is what the
      // operator ticked and is how they recognise which output is which.
      await screen.findByText('[COMPANY] Cap Table.csv');
      expect(screen.getByText(/from Acme Cap Table\.csv/)).toBeInTheDocument();
    });

    it('reports a failure rather than leaving the button spinning', async () => {
      mockApi([
        [/\/ai\/anonymize$/, () => json({ status: 503, detail: 'redactor unavailable' }, 503)],
        documents(),
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      const user = await open();
      await user.type(screen.getByLabelText(/paste a cap table/i), 'Ada Lovelace');
      await user.click(screen.getByRole('button', { name: 'Anonymize' }));
      await screen.findByText(/redactor unavailable|could not anonymize/i);
      expect(screen.getByRole('button', { name: 'Anonymize' })).toBeEnabled();
    });

    it('still offers the paste box when the document list cannot be loaded', async () => {
      mockApi([
        [/\/documents$/, () => json({ status: 500, detail: 'boom' }, 500)],
        capTable({ cap_table: STORED, can_edit: true }),
        formats(),
      ]);
      renderTab();
      await open();
      // A documents outage costs the list and nothing else — pasting is a
      // complete way to use this panel.
      expect(await screen.findByLabelText(/paste a cap table/i)).toBeInTheDocument();
    });
  });
});
