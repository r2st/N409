import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditorAccessPanel } from '../src/components/valuation/AuditorAccessPanel';

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
            ? [{ id: 'a1', label: 'PwC', expires_at: '2030-01-01T00:00:00Z', revoked_at: null, last_accessed_at: null, access_count: 0 }]
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
});
