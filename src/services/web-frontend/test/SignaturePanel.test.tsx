import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignaturePanel, type Signature } from '../src/components/SignaturePanel';
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
