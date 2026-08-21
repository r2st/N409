import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CapabilityRoster } from '../src/components/CapabilityRoster';
import type { OptionalCapability } from '../src/lib/types';

/**
 * The panel that says what the platform is not doing.
 *
 * The deployed box runs without virus scanning and without payments, and until
 * now the only record of either was a log line written once at boot. The panel
 * is not a status light: the useful part is the sentence beside the tick, which
 * says that the upload nonetheless succeeded and the file will be served back.
 * So that is what these assert — the consequence, not the boolean.
 */

const cap = (over: Partial<OptionalCapability>): OptionalCapability => ({
  key: 'virus_scanning',
  label: 'Upload virus scanning',
  configured: false,
  env: ['CLAMAV_HOST'],
  fallback: 'Uploads are accepted, stored and served back without being scanned.',
  severity: 'silent',
  ...over,
});

const respond = (body: unknown, status = 200) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );

describe('CapabilityRoster', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the consequence, not just the switch', async () => {
    respond({ capabilities: [cap({})] });
    render(<CapabilityRoster />);
    expect(await screen.findByText('Upload virus scanning')).toBeInTheDocument();
    expect(screen.getByText('not configured')).toBeInTheDocument();
    expect(screen.getByText(/served back without being scanned/)).toBeInTheDocument();
    // The variable to set, so an operator reading this knows what to do next.
    expect(screen.getByText('CLAMAV_HOST')).toBeInTheDocument();
  });

  it('marks the ones nothing downstream mentions', async () => {
    respond({
      capabilities: [
        cap({ key: 'payments', label: 'Stripe', severity: 'visible', env: ['STRIPE_SECRET_KEY'] }),
        cap({}),
      ],
    });
    render(<CapabilityRoster />);
    await screen.findByText('Upload virus scanning');
    expect(screen.getByText('Nothing downstream says this is off.')).toBeInTheDocument();
    expect(screen.getByText('The product shows this is off.')).toBeInTheDocument();
  });

  it('puts the silent ones first — a visible absence is one a reader can already see', async () => {
    respond({
      capabilities: [
        cap({ key: 'google_sso', label: 'Google', severity: 'visible' }),
        cap({ key: 'encryption', label: 'Encryption', configured: true }),
        cap({ key: 'virus_scanning', label: 'Scanning', severity: 'silent' }),
      ],
    });
    render(<CapabilityRoster />);
    await screen.findByText('Scanning');
    const labels = screen.getAllByRole('listitem').map((li) => li.querySelector('span')?.textContent);
    expect(labels).toEqual(['Scanning', 'Google', 'Encryption']);
  });

  it('says so plainly when nothing is missing — the vacuity guard', async () => {
    // Every assertion above is about a degraded row. All of them would pass
    // against a panel that reported everything off regardless of the response.
    respond({ capabilities: [cap({ configured: true })] });
    render(<CapabilityRoster />);
    expect(await screen.findByText(/Every optional integration is configured/)).toBeInTheDocument();
    expect(screen.getByText('configured')).toBeInTheDocument();
    expect(screen.queryByText('not configured')).not.toBeInTheDocument();
  });

  it('counts what is off rather than making the reader count', async () => {
    respond({
      capabilities: [cap({ key: 'a' }), cap({ key: 'b' }), cap({ key: 'c', configured: true })],
    });
    render(<CapabilityRoster />);
    expect(await screen.findByText(/2 of 3 optional integrations are not configured/)).toBeInTheDocument();
  });

  it('shows the failure instead of spinning forever', async () => {
    // Rounds 12 and 16 swept this exact shape: an error set on a failed load
    // behind a `return <Skeleton />` that never comes down.
    respond({ title: 'Forbidden', status: 403, detail: 'Ops only' }, 403);
    render(<CapabilityRoster />);
    await waitFor(() => expect(screen.getByText(/Ops only/)).toBeInTheDocument());
    expect(screen.queryByTestId('capability-roster')).not.toBeInTheDocument();
  });
});
