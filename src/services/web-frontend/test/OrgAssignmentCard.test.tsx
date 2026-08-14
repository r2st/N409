import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrgAssignmentCard } from '../src/components/valuation/OrgAssignmentCard';

/**
 * Assigning a business to an organization is what puts it in the consolidated
 * roll-up on the Portfolio page, so the two things worth pinning are that the
 * assignment carries the entity role the user chose — a subsidiary rolled up
 * as a portfolio company consolidates differently — and that a card which
 * cannot list the organizations says so rather than claiming there are none.
 */

const VAL = '01N409VAL000000000000000AA';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (detail: string, status = 422) =>
  new Response(JSON.stringify({ title: 'Unprocessable', status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

const organizations = [
  { id: 'org_1', name: 'Zorblatt Holdings' },
  { id: 'org_2', name: 'Meridian Growth Fund II' },
];

interface Sent {
  path: string;
  body: Record<string, unknown>;
}

function mockApi(orgs: unknown[] = organizations, onAssign?: () => Response) {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if ((init?.method ?? 'GET') !== 'GET') {
      sent.push({ path, body: JSON.parse(String(init!.body)) as Record<string, unknown> });
      return onAssign ? onAssign() : jsonResponse({});
    }
    if (path.endsWith('/organizations')) return jsonResponse({ organizations: orgs });
    throw new Error(`unexpected fetch ${path}`);
  });
  return sent;
}

const renderCard = () => render(<OrgAssignmentCard valuationId={VAL} />);

describe('OrgAssignmentCard', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders nothing at all until the organizations arrive', () => {
    mockApi();
    const { container } = renderCard();
    expect(container).toBeEmptyDOMElement();
  });

  it('offers every organization the caller belongs to', async () => {
    mockApi();
    renderCard();

    const select = await screen.findByLabelText('Organization');
    expect(select).toHaveTextContent('Zorblatt Holdings');
    expect(select).toHaveTextContent('Meridian Growth Fund II');
    // Nothing is preselected — a silent default would file the entity under
    // whichever organization happened to sort first.
    expect(select).toHaveValue('');
  });

  it('points a user with no organizations at the Portfolio page', async () => {
    mockApi([]);
    renderCard();
    expect(await screen.findByText(/Create an organization on the Portfolio page/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Organization')).not.toBeInTheDocument();
  });

  /**
   * A failed list was stored as an empty one, so a network blip told an owner
   * of six organizations that they had none — and offered to create a first.
   */
  it('says the list failed rather than claiming there are no organizations', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    renderCard();

    expect(await screen.findByText('Could not load your organizations.')).toBeInTheDocument();
    expect(screen.queryByText(/Create an organization on the Portfolio page/)).not.toBeInTheDocument();
  });

  it('will not assign until an organization is chosen', async () => {
    const sent = mockApi();
    renderCard();
    await screen.findByLabelText('Organization');

    const assign = screen.getByRole('button', { name: 'Assign to portfolio' });
    expect(assign).toBeDisabled();
    await userEvent.click(assign);
    expect(sent).toHaveLength(0);
  });

  it('assigns the valuation under the entity role the user picked', async () => {
    const sent = mockApi();
    renderCard();

    await userEvent.selectOptions(await screen.findByLabelText('Organization'), 'org_2');
    await userEvent.selectOptions(screen.getByLabelText('Entity role'), 'subsidiary');
    await userEvent.click(screen.getByRole('button', { name: 'Assign to portfolio' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.path).toContain('/organizations/org_2/entities');
    expect(sent[0]!.body).toEqual({ valuation_id: VAL, entity_type: 'subsidiary' });
    expect(await screen.findByText('Assigned to the organization.')).toBeInTheDocument();
  });

  /** Portfolio company is the default because it is the common case. */
  it('defaults the entity role to portfolio company', async () => {
    const sent = mockApi();
    renderCard();

    await userEvent.selectOptions(await screen.findByLabelText('Organization'), 'org_1');
    await userEvent.click(screen.getByRole('button', { name: 'Assign to portfolio' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.entity_type).toBe('portfolio_company');
  });

  it('reports a refused assignment and leaves the choice in place', async () => {
    mockApi(organizations, () => problem('This business is already in another organization.', 409));
    renderCard();

    await userEvent.selectOptions(await screen.findByLabelText('Organization'), 'org_1');
    await userEvent.click(screen.getByRole('button', { name: 'Assign to portfolio' }));

    expect(await screen.findByText('This business is already in another organization.')).toBeInTheDocument();
    expect(screen.queryByText('Assigned to the organization.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Organization')).toHaveValue('org_1');
  });

  it('falls back to a plain message when the assignment fails without a problem body', async () => {
    mockApi(organizations, () => {
      throw new TypeError('network down');
    });
    renderCard();

    await userEvent.selectOptions(await screen.findByLabelText('Organization'), 'org_1');
    await userEvent.click(screen.getByRole('button', { name: 'Assign to portfolio' }));

    expect(await screen.findByText('Could not assign to the organization.')).toBeInTheDocument();
  });

  /** A second attempt starts clean — the old success must not stand under it. */
  it('clears the previous confirmation when assigning again', async () => {
    let fail = false;
    mockApi(organizations, () =>
      fail ? problem('This business is already in another organization.', 409) : jsonResponse({}),
    );
    renderCard();

    await userEvent.selectOptions(await screen.findByLabelText('Organization'), 'org_1');
    await userEvent.click(screen.getByRole('button', { name: 'Assign to portfolio' }));
    await screen.findByText('Assigned to the organization.');

    fail = true;
    await userEvent.click(screen.getByRole('button', { name: 'Assign to portfolio' }));
    expect(await screen.findByText('This business is already in another organization.')).toBeInTheDocument();
    expect(screen.queryByText('Assigned to the organization.')).not.toBeInTheDocument();
  });
});
