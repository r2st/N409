import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MfaCard } from '../src/components/MfaCard';

const user = {
  id: 'u1',
  email: 'a@b.com',
  first_name: null,
  last_name: null,
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles: ['valuation_user'],
  totp_enabled: false,
};

const setUser = vi.fn();
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user, setUser }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(overrides: Partial<Record<string, () => Response>> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${String(url).replace(/^.*\/api\/v1/, '')}`;
    for (const [pattern, responder] of Object.entries(overrides)) {
      if (key.includes(pattern)) return responder!();
    }
    if (key === 'GET /account/mfa') {
      return jsonResponse({
        enabled: false,
        confirmed_at: null,
        backup_codes_remaining: 0,
        required: false,
        can_enroll: true,
      });
    }
    throw new Error(`unexpected fetch ${key}`);
  });
}

describe('MfaCard (feature 2)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the disabled state with a setup button', async () => {
    mockApi();
    render(<MfaCard />);
    expect(await screen.findByTestId('mfa-state')).toHaveTextContent('Disabled');
    expect(screen.getByRole('button', { name: /set up two-factor/i })).toBeInTheDocument();
  });

  it('walks through QR setup and confirmation, surfacing backup codes', async () => {
    const u = userEvent.setup();
    mockApi({
      'POST /account/mfa/setup': () =>
        jsonResponse({
          secret: 'ABCDEF234567',
          otpauth_uri: 'otpauth://totp/N409:a@b.com?secret=ABCDEF234567',
          qr: 'data:image/png;base64,iVBORw0KGgo=',
        }),
      'POST /account/mfa/confirm': () =>
        jsonResponse({ enabled: true, backup_codes: ['AAAA-BBBB', 'CCCC-DDDD'] }),
    });
    render(<MfaCard />);

    await u.click(await screen.findByRole('button', { name: /set up two-factor/i }));
    expect(await screen.findByAltText('TOTP QR code')).toBeInTheDocument();
    expect(screen.getByText('ABCDEF234567')).toBeInTheDocument();

    await u.type(screen.getByLabelText('Authenticator code'), '123456');
    await u.click(screen.getByRole('button', { name: /enable 2fa/i }));

    await waitFor(() => expect(screen.getByTestId('backup-codes')).toBeInTheDocument());
    expect(screen.getByText('AAAA-BBBB')).toBeInTheDocument();
    expect(setUser).toHaveBeenCalledWith(expect.objectContaining({ totp_enabled: true }));
  });

  it('shows an SSO account cannot enrol', async () => {
    mockApi({
      'GET /account/mfa': () =>
        jsonResponse({
          enabled: false,
          confirmed_at: null,
          backup_codes_remaining: 0,
          required: false,
          can_enroll: false,
        }),
    });
    render(<MfaCard />);
    expect(await screen.findByText(/signs in with Google SSO/i)).toBeInTheDocument();
  });
});
