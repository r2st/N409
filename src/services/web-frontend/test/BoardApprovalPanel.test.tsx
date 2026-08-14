import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardApprovalPanel } from '../src/components/BoardApprovalPanel';
import type { Valuation } from '../src/lib/types';

/**
 * The board-approval console — the last step before a 409A is defensible.
 *
 * The approval timestamp on this panel is the safe-harbor record, so the things
 * worth asserting are the ones that would let ops believe an adoption happened
 * when it did not:
 *
 *   * the resolution carries the concluded FMV and its as-of date, not a
 *     re-derived one;
 *   * a signed member cannot be quietly removed or re-emailed, and an approved
 *     resolution cannot be regenerated out from under the signatures it holds;
 *   * a signing link that has expired says so on the row, because the failure
 *     without it is silent — the director clicks a dead link and the console
 *     still reads "pending";
 *   * the resolution body is sanitized before it is injected.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VALUATION = { id: 'val-1', company_name: 'Acme' } as Valuation;

interface Resolution {
  id: string;
  valuation_date: string;
  fmv_conclusion: string;
  currency: string;
  body_html: string;
  status: 'pending' | 'approved' | 'rejected';
  approved_at: string | null;
  updated_at: string;
}

const RESOLUTION: Resolution = {
  id: 'res-1',
  valuation_date: '2026-06-30',
  fmv_conclusion: '2.7400',
  currency: 'USD',
  body_html: '<h1>Unanimous Written Consent</h1><p>The Board adopts $2.74 per share.</p>',
  status: 'pending',
  approved_at: null,
  updated_at: '2026-08-01T00:00:00.000Z',
};

interface Member {
  id: string;
  member_name: string;
  member_email: string;
  member_title: string | null;
  status: 'pending' | 'signed' | 'rejected';
  comment: string | null;
  sent_at: string | null;
  signed_at: string | null;
  token_expires_at?: string | null;
}

const member = (over: Partial<Member> = {}): Member => ({
  id: 'mem-1',
  member_name: 'Dana Director',
  member_email: 'dana@board.example',
  member_title: 'Chair',
  status: 'pending',
  comment: null,
  sent_at: null,
  signed_at: null,
  token_expires_at: null,
  ...over,
});

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function mockApi(
  state: { resolution?: Resolution | null; members?: Member[] },
  opts: { loadStatus?: number; writeStatus?: number; token?: string } = {},
) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (method === 'GET') {
      if (opts.loadStatus) return jsonResponse({ status: opts.loadStatus, detail: 'No' }, opts.loadStatus);
      return jsonResponse({ resolution: state.resolution ?? null, members: state.members ?? [] });
    }
    if (opts.writeStatus) {
      return jsonResponse({ status: opts.writeStatus, detail: 'Refused by the server.' }, opts.writeStatus);
    }
    if (path.endsWith('/board/members')) {
      return jsonResponse({ sign_token: opts.token ?? 'tok-abc' }, 201);
    }
    return jsonResponse({ ok: true });
  });
  return calls;
}

const renderPanel = () => render(<BoardApprovalPanel valuation={VALUATION} />);

describe('BoardApprovalPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('offers to generate a resolution when there is none', async () => {
    mockApi({ resolution: null });
    renderPanel();

    await screen.findByRole('button', { name: 'Generate resolution' });
    expect(screen.getByText(/safe-harbor adoption/)).toBeInTheDocument();
  });

  /**
   * A board that failed to load is not a board that does not exist.
   *
   * `catch { setData({ resolution: null, members: [] }) }` put the panel into
   * its no-resolution branch — the safe-harbor blurb over a "Generate
   * resolution" button — on an engagement that may already carry an approved
   * resolution and a full set of signatures. Generating replaces it: the
   * control for doing so deliberately reads "Regenerate (clears signatures)".
   * So a read that failed invited an appraiser to destroy the safe-harbor
   * record it was too broken to show them.
   *
   * The panel still must not take the surrounding valuation page down, which
   * is what the 403 case was originally written for.
   */
  it('reports an unreadable board rather than offering to generate over it', async () => {
    mockApi({}, { loadStatus: 403 });
    renderPanel();

    expect(await screen.findByText('No')).toBeInTheDocument();
    // The panel is still on the page — only its contents are missing.
    expect(screen.getByText('Board approval')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate resolution' })).not.toBeInTheDocument();
    expect(screen.queryByText(/safe-harbor adoption/)).not.toBeInTheDocument();
  });

  /**
   * The same offer used to be on screen during the load itself, because `data`
   * starts null and the branch keys off the resolution rather than off whether
   * anything has been read. On a slow board endpoint the button was there to
   * be clicked before the resolution it would have cleared arrived.
   */
  it('offers nothing until the board has actually been read', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}) as Promise<Response>);
    renderPanel();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading board approval');
    expect(screen.queryByRole('button', { name: 'Generate resolution' })).not.toBeInTheDocument();
  });

  it('generates the resolution and shows the concluded figure it was built from', async () => {
    const calls = mockApi({ resolution: null });
    let generated = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ path, method, body: undefined });
      if (method === 'POST') {
        generated = true;
        return jsonResponse({ resolution: RESOLUTION }, 201);
      }
      return jsonResponse({ resolution: generated ? RESOLUTION : null, members: [] });
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Generate resolution' }));

    // The number on the resolution is the one the valuation concluded, shown in
    // its own currency — a board adopting a different figure is the failure.
    await screen.findByText(/USD/);
    expect(screen.getByText(/2\.7400/)).toBeInTheDocument();
    expect(screen.getByText('2026-06-30')).toBeInTheDocument();
  });

  it('reports a refusal to generate instead of leaving the button looking idle', async () => {
    mockApi({ resolution: null }, { writeStatus: 409 });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Generate resolution' }));

    await screen.findByText('Refused by the server.');
  });

  it('renders the resolution body, sanitized', async () => {
    mockApi({
      resolution: {
        ...RESOLUTION,
        body_html: '<p>Adopted.</p><script>window.__pwned = true;</script><img src=x onerror="alert(1)">',
      },
    });
    renderPanel();

    await screen.findByText('View resolution text');
    expect(screen.getByText('Adopted.')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('[onerror]')).toBeNull();
  });

  it('says so when no board members have been added', async () => {
    mockApi({ resolution: RESOLUTION });
    renderPanel();

    await screen.findByText('No board members added yet.');
  });

  it('adds a member and hands back a shareable signing link', async () => {
    const calls = mockApi({ resolution: RESOLUTION }, { token: 'tok-xyz' });
    renderPanel();
    await screen.findByText('No board members added yet.');

    await userEvent.type(screen.getByLabelText('Name'), '  Dana Director  ');
    await userEvent.type(screen.getByLabelText('Email'), ' dana@board.example ');
    await userEvent.type(screen.getByLabelText(/Title/), ' Chair ');
    await userEvent.click(screen.getByRole('button', { name: 'Add board member' }));

    await screen.findByText(/board-sign#token=tok-xyz/);
    expect(calls.find((c) => c.path.endsWith('/board/members'))?.body).toEqual({
      name: 'Dana Director',
      email: 'dana@board.example',
      title: 'Chair',
    });
    // The form empties so the next director is not a duplicate of the last.
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it('sends no title when the optional field is left blank', async () => {
    const calls = mockApi({ resolution: RESOLUTION });
    renderPanel();
    await screen.findByText('No board members added yet.');

    await userEvent.type(screen.getByLabelText('Name'), 'Robin Rep');
    await userEvent.type(screen.getByLabelText('Email'), 'robin@board.example');
    await userEvent.click(screen.getByRole('button', { name: 'Add board member' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect((calls.find((c) => c.method === 'POST')?.body as { title: unknown }).title).toBeNull();
  });

  it('will not submit a member with no name or no email, and names both boxes', async () => {
    const calls = mockApi({ resolution: RESOLUTION });
    renderPanel();
    await screen.findByText('No board members added yet.');

    await userEvent.click(screen.getByRole('button', { name: 'Add board member' }));

    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(screen.getByText('Email is required.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  /**
   * The address is where the signing link is sent, and a link that bounces is
   * discovered when the safe-harbor record turns out to be short a signature.
   * The disabled button this replaces only checked that the box was not empty.
   */
  it('refuses an address that could not receive the signing link', async () => {
    const calls = mockApi({ resolution: RESOLUTION });
    renderPanel();
    await screen.findByText('No board members added yet.');

    await userEvent.type(screen.getByLabelText('Name'), 'Dana');
    await userEvent.type(screen.getByLabelText('Email'), 'dana@board');
    await userEvent.click(screen.getByRole('button', { name: 'Add board member' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('reports a duplicate member instead of appearing to add them', async () => {
    mockApi({ resolution: RESOLUTION }, { writeStatus: 409 });
    renderPanel();
    await screen.findByText('No board members added yet.');

    await userEvent.type(screen.getByLabelText('Name'), 'Dana Director');
    await userEvent.type(screen.getByLabelText('Email'), 'dana@board.example');
    await userEvent.click(screen.getByRole('button', { name: 'Add board member' }));

    await screen.findByText('Refused by the server.');
    // The typed values survive, so the correction is an edit and not a retype.
    expect(screen.getByLabelText('Name')).toHaveValue('Dana Director');
  });

  it('emails a link, then offers to resend it', async () => {
    const calls = mockApi({ resolution: RESOLUTION, members: [member()] });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Email link' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/members/mem-1/send'))).toBe(true),
    );

    vi.restoreAllMocks();
    mockApi({ resolution: RESOLUTION, members: [member({ sent_at: '2026-08-02T00:00:00Z' })] });
    renderPanel();
    expect(await screen.findAllByRole('button', { name: 'Resend link' })).toHaveLength(1);
  });

  it('reports a send that failed, so nobody assumes the director was emailed', async () => {
    mockApi({ resolution: RESOLUTION, members: [member()] }, { writeStatus: 502 });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Email link' }));

    await screen.findByText('Refused by the server.');
  });

  it('removes a pending member', async () => {
    const calls = mockApi({ resolution: RESOLUTION, members: [member()] });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'remove' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/members/mem-1'))).toBe(true),
    );
  });

  it('reports a removal the server refused', async () => {
    mockApi({ resolution: RESOLUTION, members: [member()] }, { writeStatus: 409 });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'remove' }));

    await screen.findByText('Refused by the server.');
  });

  it('offers neither resend nor removal once a member has signed', async () => {
    // A recorded decision is evidence. Re-minting a token or deleting the row
    // would erase it.
    mockApi({
      resolution: RESOLUTION,
      members: [
        member({
          status: 'signed',
          signed_at: '2026-08-03T15:04:00.000Z',
          comment: 'Adopted as presented.',
        }),
      ],
    });
    renderPanel();

    const row = (await screen.findByText('Dana Director')).closest('li') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /link/ })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'remove' })).not.toBeInTheDocument();
    expect(within(row).getByText('signed')).toBeInTheDocument();
    expect(within(row).getByText('“Adopted as presented.”')).toBeInTheDocument();
  });

  it('flags a signing link that has already expired', async () => {
    // Relative to now, so the row says the same thing whenever this is run.
    const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
    mockApi({
      resolution: RESOLUTION,
      members: [member({ sent_at: daysFromNow(-20), token_expires_at: daysFromNow(-1) })],
    });
    renderPanel();

    expect(await screen.findByText('Link expired — resend')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend link' })).toBeInTheDocument();
  });

  it('warns before a live link lapses, but not while there is plenty of time', async () => {
    const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
    mockApi({
      resolution: RESOLUTION,
      members: [
        member({ id: 'soon', sent_at: daysFromNow(-9), token_expires_at: daysFromNow(2.5) }),
        member({
          id: 'later',
          member_name: 'Robin Rep',
          sent_at: daysFromNow(-1),
          token_expires_at: daysFromNow(25),
        }),
      ],
    });
    renderPanel();

    const soon = (await screen.findByText('Dana Director')).closest('li') as HTMLElement;
    expect(within(soon).getByText('Link expires in 3 days')).toBeInTheDocument();
    const later = screen.getByText('Robin Rep').closest('li') as HTMLElement;
    expect(within(later).queryByText(/Link expires/)).not.toBeInTheDocument();
  });

  it('stays quiet about a countdown on a link that was never sent', async () => {
    // The row's next action is "Email link" either way; a countdown on a token
    // nobody holds is noise.
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    mockApi({ resolution: RESOLUTION, members: [member({ sent_at: null, token_expires_at: soon })] });
    renderPanel();

    await screen.findByRole('button', { name: 'Email link' });
    expect(screen.queryByText(/Link expires/)).not.toBeInTheDocument();
  });

  it('shows the approved state and stops offering to regenerate', async () => {
    mockApi({
      resolution: { ...RESOLUTION, status: 'approved', approved_at: '2026-08-05T12:00:00.000Z' },
      members: [member({ status: 'signed', signed_at: '2026-08-05T12:00:00.000Z' })],
    });
    renderPanel();

    await screen.findByText('Approved');
    // The adoption timestamp is the safe-harbor record; it has to be on screen,
    // not merely in the row's status.
    expect(screen.getByText(/^Approved \w/)).toBeInTheDocument();
    // Regenerating clears signatures; on an adopted resolution that would
    // destroy the safe-harbor record.
    expect(screen.queryByRole('button', { name: /Regenerate/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add board member' })).not.toBeInTheDocument();
  });

  it('shows a rejected resolution as rejected', async () => {
    mockApi({
      resolution: { ...RESOLUTION, status: 'rejected' },
      members: [member({ status: 'rejected', comment: 'Numbers do not tie.' })],
    });
    renderPanel();

    await screen.findByText('Rejected');
    expect(screen.getByText('“Numbers do not tie.”')).toBeInTheDocument();
    // Still open for correction — a rejected resolution can be regenerated.
    expect(screen.getByRole('button', { name: /Regenerate/ })).toBeInTheDocument();
  });

  it('regenerates a pending resolution on request', async () => {
    const calls = mockApi({ resolution: RESOLUTION, members: [member()] });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /Regenerate/ }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/board'))).toBe(true),
    );
  });
});
