import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DataTable, Pagination, pageCountOf, type Column } from '../src/components/ui';

interface Row {
  id: string;
  company: string;
  fmv: number;
}
const ROWS: Row[] = [
  { id: 'a', company: 'Acme', fmv: 1.23 },
  { id: 'b', company: 'Globex', fmv: 4.56 },
];
const COLUMNS: Array<Column<Row>> = [
  { key: 'company', header: 'Company' },
  { key: 'fmv', header: 'FMV', align: 'right', render: (r) => `$${r.fmv.toFixed(2)}` },
];

describe('DataTable (F-4 P3)', () => {
  it('renders scoped column headers and one row per item', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} caption="Valuations" />);
    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['Company', 'FMV']);
    expect(headers[0]).toHaveAttribute('scope', 'col');
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('$4.56')).toBeInTheDocument(); // custom render
  });

  it('shows the empty state spanning all columns when there are no rows', () => {
    render(<DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} empty="No valuations yet" />);
    const cell = screen.getByText('No valuations yet');
    expect(cell).toHaveAttribute('colspan', String(COLUMNS.length));
  });

  it('falls back to String(row[key]) when no render is given', () => {
    render(<DataTable columns={[{ key: 'company', header: 'Company' }]} rows={ROWS} rowKey={(r) => r.id} />);
    expect(screen.getByText('Globex')).toBeInTheDocument();
  });

  it('invokes onRowClick with the clicked row', async () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowClick={onRowClick} />);
    await userEvent.click(screen.getByText('Acme'));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  /**
   * `onRowClick` alone is mouse-only: a `<tr onClick>` is not focusable and has
   * no key binding, so a table whose only way in was the row click could not be
   * opened without a pointer at all.
   */
  it('gives a clickable row a keyboard way in, on the first column', async () => {
    render(
      <MemoryRouter>
        <DataTable
          columns={COLUMNS}
          rows={ROWS}
          rowKey={(r) => r.id}
          onRowClick={vi.fn()}
          rowHref={(r) => `/valuations/${r.id}`}
        />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Acme' });
    expect(link).toHaveAttribute('href', '/valuations/a');
    await userEvent.tab();
    expect(link).toHaveFocus();

    // Only the first column becomes a link — the rest of the row is data, and
    // a link per cell would put four identical stops in the tab order.
    expect(screen.getAllByRole('link')).toHaveLength(ROWS.length);
  });

  it('links nothing when the table leads nowhere', () => {
    render(
      <MemoryRouter>
        <DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />
      </MemoryRouter>,
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

describe('pageCountOf', () => {
  it('computes ceil(total/pageSize), min 1', () => {
    expect(pageCountOf(0, 10)).toBe(1);
    expect(pageCountOf(10, 10)).toBe(1);
    expect(pageCountOf(11, 10)).toBe(2);
    expect(pageCountOf(25, 10)).toBe(3);
    expect(pageCountOf(5, 0)).toBe(1); // guards divide-by-zero
  });
});

describe('Pagination (F-4 P3)', () => {
  it('renders nothing for a single page', () => {
    const { container } = render(<Pagination page={1} pageCount={1} onPage={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('disables Previous on the first page and Next on the last', () => {
    const { rerender } = render(<Pagination page={1} pageCount={3} onPage={() => {}} />);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
    rerender(<Pagination page={3} pageCount={3} onPage={() => {}} />);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('reports the current page and steps via onPage', async () => {
    const onPage = vi.fn();
    render(<Pagination page={2} pageCount={5} onPage={onPage} />);
    expect(screen.getByText('Page 2 of 5')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPage).toHaveBeenCalledWith(3);
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPage).toHaveBeenCalledWith(1);
  });

  it('clamps an out-of-range page prop', () => {
    render(<Pagination page={99} pageCount={4} onPage={() => {}} />);
    expect(screen.getByText('Page 4 of 4')).toBeInTheDocument();
  });
});

/**
 * A list that shrinks under a reader who had paged into it.
 *
 * No route clamps `page`: `domain/pagination.ts` states outright that a page
 * past the end matches nothing and answers with an empty list. So when a
 * delete, a purge or a 15-second poll drops the total, the owner is left asking
 * for a page that no longer exists — and the only control that could walk it
 * back is this one.
 */
describe('Pagination — a page the list no longer has', () => {
  it('asks the owner to come back into range instead of labelling a page it never fetched', () => {
    const onPage = vi.fn();
    render(<Pagination page={99} pageCount={4} onPage={onPage} />);
    // Without this the label read "Page 4 of 4" over rows fetched at page 99.
    expect(onPage).toHaveBeenCalledWith(4);
  });

  it('still asks when the list collapsed to a single page and the control renders nothing', () => {
    const onPage = vi.fn();
    const { container } = render(<Pagination page={3} pageCount={1} onPage={onPage} />);
    // This is the dead end: no control to click, and page 3 fetches nothing.
    expect(container).toBeEmptyDOMElement();
    expect(onPage).toHaveBeenCalledWith(1);
  });

  it('leaves an in-range owner alone', () => {
    const onPage = vi.fn();
    const { rerender } = render(<Pagination page={2} pageCount={5} onPage={onPage} />);
    rerender(<Pagination page={1} pageCount={1} onPage={onPage} />);
    rerender(<Pagination page={5} pageCount={5} onPage={onPage} />);
    expect(onPage).not.toHaveBeenCalled();
  });

  it('settles in one pass once the owner adopts the clamped page', () => {
    const onPage = vi.fn();
    const { rerender } = render(<Pagination page={9} pageCount={2} onPage={onPage} />);
    expect(onPage).toHaveBeenCalledTimes(1);
    // The owner refetched at page 2; the effect must not fire again.
    rerender(<Pagination page={2} pageCount={2} onPage={onPage} />);
    rerender(<Pagination page={2} pageCount={2} onPage={onPage} />);
    expect(onPage).toHaveBeenCalledTimes(1);
  });
});
