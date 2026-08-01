import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AttentionBand } from '../src/components/AttentionBand';
import type { AttentionItem } from '../src/lib/attention';

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: '01N409VAL000000000000000AA',
  company_name: 'Acme',
  state: 'started',
  kind: '409a',
  reason: 'overdue',
  severity: 'high',
  days: 3,
  detail: '3 days past due',
  ...over,
});

const renderBand = (props: Parameters<typeof AttentionBand>[0]) =>
  render(
    <MemoryRouter>
      <AttentionBand {...props} />
    </MemoryRouter>,
  );

describe('AttentionBand', () => {
  it('renders nothing at all when nothing needs attention', () => {
    const { container } = renderBand({ items: [] });
    // Not an empty panel — an empty panel that is always present stops being read.
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the reason and the date detail, and links each row to its valuation', () => {
    renderBand({ items: [item({ company_name: 'Northwind', id: '01N409VAL000000000000000BB' })] });

    const band = screen.getByRole('region', { name: 'Needs attention' });
    expect(within(band).getByText('Northwind')).toBeInTheDocument();
    expect(within(band).getByText('Overdue')).toBeInTheDocument();
    expect(within(band).getByText(/3 days past due/)).toBeInTheDocument();
    expect(within(band).getAllByRole('link')[0]).toHaveAttribute(
      'href',
      '/valuations/01N409VAL000000000000000BB',
    );
  });

  it('words the held-up reason for whoever is reading it', () => {
    const held = [item({ reason: 'action_needed', detail: 'Held up pending information' })];

    const client = renderBand({ items: held });
    // The client is the one being waited on, so it is addressed to them.
    expect(screen.getByText('Needs your input')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs your attention' })).toBeInTheDocument();
    client.unmount();

    renderBand({ items: held, isOps: true });
    // Ops are not being asked for anything — the ball is on the client's side.
    expect(screen.getByText('Waiting on client')).toBeInTheDocument();
    expect(screen.queryByText('Needs your input')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
  });

  it('counts everything but shows a handful, deferring the rest to the worklist', () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      item({ id: `01N409VAL00000000000000${String(i).padStart(2, '0')}`, company_name: `Co ${i}` }),
    );
    renderBand({ items, limit: 5 });

    expect(screen.getByText('9 valuations')).toBeInTheDocument();
    expect(screen.getByText('Co 0')).toBeInTheDocument();
    expect(screen.getByText('Co 4')).toBeInTheDocument();
    expect(screen.queryByText('Co 5')).not.toBeInTheDocument();

    const more = screen.getByRole('link', { name: /4 more need attention/ });
    expect(more).toHaveAttribute('href', '/valuations');
  });

  it('makes the overflow link and the header count agree in the singular', () => {
    const items = [item({ id: 'a', company_name: 'One' }), item({ id: 'b', company_name: 'Two' })];
    renderBand({ items, limit: 1 });

    expect(screen.getByText('2 valuations')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /1 more needs attention/ })).toBeInTheDocument();
  });

  it('omits the overflow link when every row is already on screen', () => {
    renderBand({ items: [item()], limit: 5 });
    expect(screen.getByText('1 valuation')).toBeInTheDocument();
    expect(screen.queryByText(/more need/)).not.toBeInTheDocument();
  });
});
