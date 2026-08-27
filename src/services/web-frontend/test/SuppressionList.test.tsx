import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SuppressionList } from '../src/components/SuppressionList';

/**
 * Lifting an email suppression — the recovery path the API documented and the
 * product did not have.
 *
 * A hard bounce or one spam complaint suppresses an address permanently and
 * automatically. From then on the outbox files every message to it as
 * `skipped`, and until R178 there was no screen that would name the addresses
 * on the list or take one off. The failure is quiet in the worst way: a client
 * stops receiving their own 409A report, nothing errors, and the row that
 * explains it is on a page nobody built.
 *
 * Four things are pinned. The list has to be *readable* — a failed load must
 * not render as "nobody is blocked". Releasing has to reach the release route
 * with the address in the **body**, because the address is PII and a path is
 * the part of a request everything logs. A released row has to stay visible as
 * history rather than vanish. And the cap has to report itself: this list is
 * read in order to find one address, and an address that fell off the end is
 * one nobody can find and nobody can release.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (detail: string, status = 422) =>
  new Response(JSON.stringify({ title: 'Unprocessable', status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

const row = (o: Partial<{ to_email: string; reason: string; released_at: string | null }> = {}) => ({
  to_email: o.to_email ?? 'founder@zorblatt.example',
  reason: o.reason ?? 'hard',
  detail: 'mailbox unavailable',
  outbox_id: null,
  created_at: '2026-08-01T09:00:00.000Z',
  released_at: o.released_at ?? null,
  released_by: null,
});

interface Sent {
  path: string;
  method: string;
  body: unknown;
}

function mockApi(
  pages: Array<{ suppressions: ReturnType<typeof row>[]; truncated?: boolean }>,
  onRelease?: () => Response,
) {
  const sent: Sent[] = [];
  const queue = [...pages];
  const gets: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({
        path,
        method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return onRelease ? onRelease() : new Response(null, { status: 204 });
    }
    gets.push(path);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return jsonResponse({ suppressions: next.suppressions, truncated: next.truncated ?? false });
  });
  return { sent, gets };
}

describe('SuppressionList', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says the list could not be loaded rather than that nobody is blocked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem('Nope', 500));
    render(<SuppressionList />);

    expect(await screen.findByText(/Could not load the suppression list/)).toBeInTheDocument();
    // The reassuring sentence is exactly the wrong one to show here.
    expect(screen.queryByText(/No address is currently suppressed/)).not.toBeInTheDocument();
  });

  it('releases an address through the body, never the path', async () => {
    const { sent } = mockApi([
      { suppressions: [row()] },
      { suppressions: [row({ released_at: '2026-08-27T10:00:00.000Z' })] },
    ]);
    render(<SuppressionList />);

    await userEvent.click(await screen.findByRole('button', { name: 'Release' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.path).toContain('/admin/email/suppressions/release');
    expect(sent[0]!.body).toEqual({ address: 'founder@zorblatt.example' });
    // The address is PII; a path is logged by everything in front of the app.
    expect(sent[0]!.path).not.toContain('founder@zorblatt.example');

    // Re-read, so the row shows what the server actually did with it.
    expect(await screen.findByText(/Released/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release' })).not.toBeInTheDocument();
  });

  it('keeps a released row as history rather than dropping it', async () => {
    const { gets } = mockApi([
      { suppressions: [] },
      { suppressions: [row({ released_at: '2026-08-20T10:00:00.000Z' })] },
    ]);
    render(<SuppressionList />);

    await screen.findByText(/No address is currently suppressed/);
    await userEvent.click(screen.getByLabelText('Show released'));

    expect(await screen.findByText('founder@zorblatt.example')).toBeInTheDocument();
    expect(gets.some((g) => g.includes('include_released=true'))).toBe(true);
  });

  it('reports the cap, because a row past it is one nobody can release', async () => {
    mockApi([{ suppressions: [row()], truncated: true }]);
    render(<SuppressionList />);

    expect(await screen.findByTestId('list-truncated')).toHaveTextContent(/More exist than are listed/);
  });

  it('surfaces a refused release instead of leaving the row looking lifted', async () => {
    mockApi([{ suppressions: [row()] }], () => problem('No active suppression for that address', 404));
    render(<SuppressionList />);

    await userEvent.click(await screen.findByRole('button', { name: 'Release' }));
    expect(await screen.findByText(/No active suppression for that address/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Release' })).toBeInTheDocument();
  });
});
