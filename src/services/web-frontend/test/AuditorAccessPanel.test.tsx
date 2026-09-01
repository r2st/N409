import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditorAccessPanel } from '../src/components/valuation/AuditorAccessPanel';
import { OFFLINE_DETAIL } from '../src/lib/api';

const VAL = '01N409VAL000000000000000AA';
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(overrides: Partial<Record<string, () => Response>> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${String(url).replace(/^.*\/api\/v1/, '')}`;
    for (const [pattern, r] of Object.entries(overrides)) if (key.includes(pattern)) return r!();
    if (key.includes(`GET /valuations/${VAL}/auditor-access`)) return jsonResponse({ access: [] });
    throw new Error(`unexpected fetch ${key}`);
  });
}

describe('AuditorAccessPanel (feature 8)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('mints a link and reveals the URL once', async () => {
    const user = userEvent.setup();
    let created = false;
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/auditor-access': () => {
        created = true;
        return jsonResponse(
          { url: 'https://app.example.com/auditor#token=abc123', access: { id: 'a1' }, token: 'abc123' },
          201,
        );
      },
      'GET /valuations/01N409VAL000000000000000AA/auditor-access': () =>
        jsonResponse({
          access: created
            ? [
                {
                  id: 'a1',
                  label: 'PwC',
                  expires_at: '2030-01-01T00:00:00Z',
                  revoked_at: null,
                  last_accessed_at: null,
                  access_count: 0,
                },
              ]
            : [],
        }),
    });

    render(<AuditorAccessPanel valuationId={VAL} />);
    await user.click(await screen.findByRole('button', { name: 'Create link' }));
    await waitFor(() =>
      expect(screen.getByText('https://app.example.com/auditor#token=abc123')).toBeInTheDocument(),
    );
    expect(screen.getByText('PwC')).toBeInTheDocument();
  });

  /** The label and expiry the link is minted with. */
  it('sends the label and expiry that were chosen', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | undefined;
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/auditor-access': () =>
        jsonResponse({ url: 'https://app.example.com/auditor#token=x', access: { id: 'a1' } }, 201),
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        body = JSON.parse(String(init?.body));
        return jsonResponse({ url: 'https://app.example.com/auditor#token=x', access: { id: 'a1' } }, 201);
      }
      return jsonResponse({ access: [] });
    });

    render(<AuditorAccessPanel valuationId={VAL} />);
    await user.type(await screen.findByPlaceholderText('e.g. Deloitte'), 'Deloitte');
    await user.selectOptions(screen.getByLabelText('Expiry'), '90');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    // Days is a select value — a string — and the API takes a number.
    await waitFor(() => expect(body).toEqual({ label: 'Deloitte', expires_in_days: 90 }));
  });

  /** A blank label is omitted rather than sent as an empty string. */
  it('omits an unfilled label', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        body = JSON.parse(String(init?.body));
        return jsonResponse({ url: 'https://x/#token=y', access: { id: 'a1' } }, 201);
      }
      return jsonResponse({ access: [] });
    });

    render(<AuditorAccessPanel valuationId={VAL} />);
    await user.type(await screen.findByPlaceholderText('e.g. Deloitte'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    await waitFor(() => expect(body).toEqual({ expires_in_days: 30 }));
  });

  it('surfaces why a link could not be created', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/auditor-access': () =>
        jsonResponse({ detail: 'Publish the valuation first.' }, 409),
    });

    render(<AuditorAccessPanel valuationId={VAL} />);
    await user.click(await screen.findByRole('button', { name: 'Create link' }));

    expect(await screen.findByText('Publish the valuation first.')).toBeInTheDocument();
  });

  it('says so when the links cannot be loaded', async () => {
    mockApi({ 'GET /valuations': () => jsonResponse({ error: { message: 'nope' } }, 500) });
    render(<AuditorAccessPanel valuationId={VAL} />);
    expect(await screen.findByText('Could not load auditor links.')).toBeInTheDocument();
  });
});

/**
 * Revoking is the control that cuts an outside firm off from the valuation.
 */
describe('AuditorAccessPanel — revoking', () => {
  beforeEach(() => vi.restoreAllMocks());

  const link = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'a1',
    label: 'PwC',
    expires_at: '2030-01-01T00:00:00Z',
    revoked_at: null,
    last_accessed_at: null,
    access_count: 3,
    ...over,
  });

  it('revokes an active link and shows it as revoked', async () => {
    const user = userEvent.setup();
    let revoked = false;
    let deleted: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        deleted = String(url);
        revoked = true;
        return new Response(null, { status: 204 });
      }
      return jsonResponse({
        access: [link(revoked ? { revoked_at: '2026-01-01T00:00:00Z' } : {})],
      });
    });

    render(<AuditorAccessPanel valuationId={VAL} />);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(deleted).toContain(`/valuations/${VAL}/auditor-access/a1`);
    // And the control is gone with it — there is nothing left to revoke.
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  /**
   * The bug: the DELETE was unguarded, so a rejected call left the row marked
   * "Active" with nothing said. The analyst who clicked Revoke had every reason
   * to believe the auditor was locked out while the link kept working.
   */
  it('says so when the revoke fails, and does not claim the link is gone', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'DELETE')
        return jsonResponse({ detail: 'Link already revoked elsewhere.' }, 409);
      return jsonResponse({ access: [link()] });
    });

    render(<AuditorAccessPanel valuationId={VAL} />);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText('Link already revoked elsewhere.')).toBeInTheDocument();
    // Still active, and still offering the only control that can cut it off.
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  /*
   * R303. Two ways a failure can carry no message of its own, which this used
   * to conflate — and after R255 routed these handlers through
   * `describeActionFailure`, the single assertion left here matched neither.
   *
   * The operation sentence is a prefix, not the whole message: what follows it
   * says which of the two happened and what the reader should do about it.
   * Asserting the prefix alone passed only while there was nothing after it.
   */
  it('names the operation and the network when the request never left', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') throw new Error('offline');
      return jsonResponse({ access: [link()] });
    });

    render(<AuditorAccessPanel valuationId={VAL} />);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    // `fetch` rejecting means the DELETE never arrived, so the link is still
    // live — and the reader is told nothing was submitted rather than left to
    // guess whether pressing Revoke again would revoke twice.
    expect(await screen.findByText(`Could not revoke the link. ${OFFLINE_DETAIL}`)).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('names the operation and the status when the server explains nothing', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      // The shape this API's own 500 handler emits: a title, deliberately no
      // `detail`, so an internal failure cannot leak its message.
      if ((init?.method ?? 'GET') === 'DELETE')
        return jsonResponse({ title: 'Internal Server Error', status: 500 }, 500);
      return jsonResponse({ access: [link()] });
    });

    render(<AuditorAccessPanel valuationId={VAL} />);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    // Not 'Internal Server Error' — the reason phrase is the one string in the
    // body guaranteed not to be about this request.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not revoke the link.');
    expect(alert).toHaveTextContent('unexpected fault (500)');
    expect(alert).not.toHaveTextContent('Internal Server Error');
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  /**
   * The banner offers the raw URL under a heading telling the reader to copy it
   * while they still can. After the link is revoked that is an invitation to
   * hand out a dead credential.
   */
  it('withdraws the minted URL once that link is revoked', async () => {
    const user = userEvent.setup();
    let created = false;
    let revoked = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        created = true;
        return jsonResponse({ url: 'https://app.example.com/auditor#token=abc', access: { id: 'a1' } }, 201);
      }
      if (method === 'DELETE') {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      return jsonResponse({
        access: created ? [link(revoked ? { revoked_at: '2026-01-01T00:00:00Z' } : {})] : [],
      });
    });

    render(<AuditorAccessPanel valuationId={VAL} />);
    await user.click(await screen.findByRole('button', { name: 'Create link' }));
    expect(await screen.findByText('https://app.example.com/auditor#token=abc')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    await waitFor(() =>
      expect(screen.queryByText('https://app.example.com/auditor#token=abc')).not.toBeInTheDocument(),
    );
  });

  /** Revoking a *different* link leaves the one just minted on screen. */
  it('keeps the minted URL when another link is the one revoked', async () => {
    const user = userEvent.setup();
    let created = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        created = true;
        return jsonResponse({ url: 'https://app.example.com/auditor#token=new', access: { id: 'a2' } }, 201);
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return jsonResponse({
        access: created ? [link({ id: 'a1', label: 'Old' }), link({ id: 'a2', label: 'New' })] : [],
      });
    });

    render(<AuditorAccessPanel valuationId={VAL} />);
    await user.click(await screen.findByRole('button', { name: 'Create link' }));
    expect(await screen.findByText('https://app.example.com/auditor#token=new')).toBeInTheDocument();

    // The first row is the old link.
    await user.click((await screen.findAllByRole('button', { name: 'Revoke' }))[0]!);

    await waitFor(() => expect(screen.getByText('Old')).toBeInTheDocument());
    expect(screen.getByText('https://app.example.com/auditor#token=new')).toBeInTheDocument();
  });

  /** An expired link is past offering a revoke control. */
  it('offers no revoke on a link that has already expired', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ access: [link({ expires_at: '2020-01-01T00:00:00Z' })] }),
    );
    render(<AuditorAccessPanel valuationId={VAL} />);

    expect(await screen.findByText('Expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  /** A link with no label reads as a dash, not as "null". */
  it('renders an unlabelled link without inventing a label', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ access: [link({ label: null })] }));
    render(<AuditorAccessPanel valuationId={VAL} />);

    expect(await screen.findByText('—')).toBeInTheDocument();
  });
});
