import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
