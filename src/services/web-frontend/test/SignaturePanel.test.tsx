import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignaturePanel, type Signature } from '../src/components/SignaturePanel';
import { OFFLINE_DETAIL } from '../src/lib/api';
import type { Valuation } from '../src/lib/types';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VALUATION = {
  id: '01TESTVALUATION0000000000A',
  state: 'draft_accepted',
} as unknown as Valuation;

const MAIN_SIGNATURE: Signature = {
  id: '01SIG0000000000000000000A',
  valuation_id: VALUATION.id,
  role: 'main',
  signer_user_id: 'u1',
  signer_name: 'Ada Analyst',
  signer_title: 'Senior Analyst',
  signature_text: '/s/ Ada Analyst',
  signed_at: '2026-07-07T00:00:00Z',
};

describe('SignaturePanel (publish gating)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the publish-blocked badge when the main signature is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ signatures: [] }));
    render(<SignaturePanel valuation={VALUATION} />);
    await waitFor(() =>
      expect(screen.getByText(/publish blocked — main signature required/i)).toBeInTheDocument(),
    );
    expect(screen.getAllByText(/not signed/i)).toHaveLength(2);
  });

  it('shows ready-to-publish once the main signature exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ signatures: [MAIN_SIGNATURE] }));
    render(<SignaturePanel valuation={VALUATION} />);
    await waitFor(() => expect(screen.getByText(/ready to publish/i)).toBeInTheDocument());
    expect(screen.getByText('/s/ Ada Analyst')).toBeInTheDocument();
    expect(screen.getByText(/ada analyst, senior analyst/i)).toBeInTheDocument();
  });

  it('signs by posting the typed signature', async () => {
    const user = userEvent.setup();
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST') {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return jsonResponse({ signature: MAIN_SIGNATURE }, 201);
      }
      return jsonResponse({ signatures: calls.length > 0 ? [MAIN_SIGNATURE] : [] });
    });

    render(<SignaturePanel valuation={VALUATION} />);
    await waitFor(() => screen.getByRole('button', { name: /^sign$/i }));

    await user.type(screen.getByLabelText(/full name/i), 'Ada Analyst');
    await user.type(screen.getByLabelText(/type to sign/i), '/s/ Ada Analyst');
    await user.click(screen.getByRole('button', { name: /^sign$/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toContain(`/valuations/${VALUATION.id}/signatures`);
    expect(calls[0]!.body).toMatchObject({
      role: 'main',
      signer_name: 'Ada Analyst',
      signature_text: '/s/ Ada Analyst',
    });
  });

  it('hides the signing form on published valuations', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ signatures: [MAIN_SIGNATURE] }));
    render(<SignaturePanel valuation={{ ...VALUATION, state: 'published' } as Valuation} />);
    await waitFor(() => expect(screen.getByText(/ready to publish/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^sign$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/remove/i)).not.toBeInTheDocument();
  });
});

/**
 * Removing a signature — the way a reviewer undoes a wrong one before publish.
 */
describe('SignaturePanel — removing a signature', () => {
  beforeEach(() => vi.restoreAllMocks());

  const SECOND: Signature = {
    ...MAIN_SIGNATURE,
    id: '01SIG0000000000000000000B',
    role: 'second',
    signer_name: 'Bo Reviewer',
    signer_title: null,
    signature_text: '/s/ Bo Reviewer',
  };

  it('removes the signature it was asked to and re-reads the list', async () => {
    const user = userEvent.setup();
    let removed = false;
    let deleted: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        deleted = String(url);
        removed = true;
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ signatures: removed ? [] : [MAIN_SIGNATURE] });
    });

    render(<SignaturePanel valuation={VALUATION} />);
    await user.click(await screen.findByRole('button', { name: 'remove' }));

    expect(deleted).toContain(`/valuations/${VALUATION.id}/signatures/main`);
    // Gone, and the publish gate closes again behind it.
    expect(await screen.findByText('Publish blocked — main signature required')).toBeInTheDocument();
  });

  /** Two signatures, two remove buttons — the right one has to go. */
  it('removes the second signature without touching the main one', async () => {
    const user = userEvent.setup();
    let deleted: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        deleted = String(url);
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ signatures: [MAIN_SIGNATURE, SECOND] });
    });

    render(<SignaturePanel valuation={VALUATION} />);
    const buttons = await screen.findAllByRole('button', { name: 'remove' });
    await user.click(buttons[1]!);

    await waitFor(() => expect(deleted).toContain('/signatures/second'));
  });

  it('says why a signature could not be removed', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'DELETE')
        return jsonResponse({ detail: 'The report is already out for review.' }, 409);
      return jsonResponse({ signatures: [MAIN_SIGNATURE] });
    });

    render(<SignaturePanel valuation={VALUATION} />);
    await user.click(await screen.findByRole('button', { name: 'remove' }));

    expect(await screen.findByText('The report is already out for review.')).toBeInTheDocument();
    // And the signature is still there, because it still is.
    expect(screen.getByText('/s/ Ada Analyst')).toBeInTheDocument();
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
      return jsonResponse({ signatures: [MAIN_SIGNATURE] });
    });

    render(<SignaturePanel valuation={VALUATION} />);
    await user.click(await screen.findByRole('button', { name: 'remove' }));

    expect(await screen.findByText(`Could not remove the signature. ${OFFLINE_DETAIL}`)).toBeInTheDocument();
  });

  it('names the operation and the status when the server explains nothing', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'DELETE')
        return jsonResponse({ title: 'Internal Server Error', status: 500 }, 500);
      return jsonResponse({ signatures: [MAIN_SIGNATURE] });
    });

    render(<SignaturePanel valuation={VALUATION} />);
    await user.click(await screen.findByRole('button', { name: 'remove' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not remove the signature.');
    expect(alert).toHaveTextContent('unexpected fault (500)');
    expect(alert).not.toHaveTextContent('Internal Server Error');
  });

  /** A published valuation's signatures are part of the record. */
  it('offers no remove once the valuation is published', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ signatures: [MAIN_SIGNATURE] }));
    render(<SignaturePanel valuation={{ ...VALUATION, state: 'published' } as Valuation} />);

    await screen.findByText('/s/ Ada Analyst');
    expect(screen.queryByRole('button', { name: 'remove' })).not.toBeInTheDocument();
  });

  /** A signer with no title reads as a name, not as a trailing comma. */
  it('renders a signature that carries no title', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ signatures: [SECOND] }));
    render(<SignaturePanel valuation={VALUATION} />);

    expect(await screen.findByText('Bo Reviewer')).toBeInTheDocument();
  });

  it('picks the role the signature is filed under', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posted = JSON.parse(String(init?.body));
        return jsonResponse({ signature: SECOND }, 201);
      }
      return jsonResponse({ signatures: [] });
    });

    render(<SignaturePanel valuation={VALUATION} />);
    await user.selectOptions(await screen.findByLabelText('Role'), 'second');
    await user.type(screen.getByLabelText('Full name'), 'Bo Reviewer');
    await user.type(screen.getByLabelText(/Title/), 'Manager');
    await user.type(screen.getByLabelText(/Type to sign/), '/s/ Bo');
    await user.click(screen.getByRole('button', { name: 'Sign' }));

    await waitFor(() =>
      expect(posted).toEqual({
        role: 'second',
        signer_name: 'Bo Reviewer',
        signer_title: 'Manager',
        signature_text: '/s/ Bo',
      }),
    );
  });

  /** An optional title left blank is null, not an empty string. */
  it('sends no title when the box is left empty', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posted = JSON.parse(String(init?.body));
        return jsonResponse({ signature: MAIN_SIGNATURE }, 201);
      }
      return jsonResponse({ signatures: [] });
    });

    render(<SignaturePanel valuation={VALUATION} />);
    await user.type(await screen.findByLabelText('Full name'), 'Ada');
    await user.type(screen.getByLabelText(/Type to sign/), '/s/ Ada');
    await user.click(screen.getByRole('button', { name: 'Sign' }));

    await waitFor(() => expect(posted?.signer_title).toBeNull());
  });
});
