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

/** jsdom's Blob has no `.text()`; FileReader is the portable way in. */
const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

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

/**
 * Types the account password and presses the enrol button.
 *
 * `/account/mfa/setup` joined the re-authentication prompts in R354: starting
 * an enrolment is what a session that is not the owner's does to finish a
 * takeover, so the QR is not shown until the password is given.
 */
async function startSetup(u: ReturnType<typeof userEvent.setup>) {
  await u.type(await screen.findByLabelText('Password'), 'hunter2hunter2');
  await u.click(screen.getByRole('button', { name: /set up two-factor/i }));
}

describe('MfaCard (feature 2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setUser.mockClear();
  });

  it('shows the disabled state with a setup button', async () => {
    mockApi();
    render(<MfaCard />);
    expect(await screen.findByTestId('mfa-state')).toHaveTextContent('Disabled');
    expect(screen.getByRole('button', { name: /set up two-factor/i })).toBeInTheDocument();
  });

  /*
   * The prompt this card did not have (R354, methodology M6).
   *
   * Every other credential-level action here is password-gated, and the server
   * refuses each without one. Starting an enrolment was not — and it is the
   * move a stolen session makes to *finish* a takeover: stage its own
   * authenticator, and the account is protected by the attacker, who is also
   * the only one holding the backup codes.
   */
  it('will not start an enrolment until the password is given', async () => {
    const u = userEvent.setup();
    const fetchSpy = mockApi({
      'POST /account/mfa/setup': () => jsonResponse({ secret: 'x', otpauth_uri: 'x', qr: 'x' }),
    });
    render(<MfaCard />);

    await u.click(await screen.findByRole('button', { name: /set up two-factor/i }));
    // Refused here rather than by a round trip that comes back 422.
    expect(await screen.findByText(/password is required/i)).toBeInTheDocument();
    expect(
      fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/account/mfa/setup')),
    ).toHaveLength(0);
    expect(screen.queryByAltText('TOTP QR code')).not.toBeInTheDocument();
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

    await startSetup(u);
    expect(await screen.findByAltText('TOTP QR code')).toBeInTheDocument();
    expect(screen.getByText('ABCDEF234567')).toBeInTheDocument();

    await u.type(screen.getByLabelText('Authenticator code'), '123456');
    await u.click(screen.getByRole('button', { name: /enable 2fa/i }));

    await waitFor(() => expect(screen.getByTestId('backup-codes')).toBeInTheDocument());
    expect(screen.getByText('AAAA-BBBB')).toBeInTheDocument();
    expect(setUser).toHaveBeenCalledWith(expect.objectContaining({ totp_enabled: true }));
  });

  /**
   * R30 — the six-digit shape was `code.trim().length < 6` on a disabled
   * button, which refused a five-digit code without saying why and accepted
   * "abcdef" without hesitation. Both go to the API as a rejected code.
   */
  it('refuses a code that is not six digits, rather than posting it', async () => {
    const u = userEvent.setup();
    const fetchSpy = mockApi({
      'POST /account/mfa/setup': () =>
        jsonResponse({
          secret: 'ABCDEF234567',
          qr: 'data:image/png;base64,iVBORw0KGgo=',
          otpauth: 'otpauth://totp/N409:ada@acme.com?secret=ABCDEF234567',
        }),
    });
    render(<MfaCard />);

    await startSetup(u);
    await u.type(await screen.findByLabelText('Authenticator code'), 'abcdef');
    await u.click(screen.getByRole('button', { name: /enable 2fa/i }));

    expect(
      await screen.findByText('Enter the six-digit code from your authenticator app.'),
    ).toBeInTheDocument();
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/confirm'))).toHaveLength(0);
  });

  it('names an empty code box as required rather than as malformed', async () => {
    const u = userEvent.setup();
    mockApi({
      'POST /account/mfa/setup': () =>
        jsonResponse({
          secret: 'ABCDEF234567',
          qr: 'data:image/png;base64,iVBORw0KGgo=',
          otpauth: 'otpauth://totp/N409:ada@acme.com?secret=ABCDEF234567',
        }),
    });
    render(<MfaCard />);

    await startSetup(u);
    await u.click(await screen.findByRole('button', { name: /enable 2fa/i }));

    expect(await screen.findByText('Authenticator code is required.')).toBeInTheDocument();
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

  it('says the status could not be loaded rather than spinning forever', async () => {
    mockApi({ 'GET /account/mfa': () => jsonResponse({ title: 'Unavailable' }, 503) });
    render(<MfaCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load two-factor status/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('surfaces a setup call that fails, leaving the enrol button usable', async () => {
    const u = userEvent.setup();
    mockApi({
      'POST /account/mfa/setup': () =>
        jsonResponse({ title: 'Too many attempts', detail: 'Try again in a minute.' }, 429),
    });
    render(<MfaCard />);

    await startSetup(u);
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in a minute.');
    expect(screen.getByRole('button', { name: /set up two-factor/i })).toBeEnabled();
  });

  it('rejects a code the server refuses without claiming 2FA is on', async () => {
    const u = userEvent.setup();
    mockApi({
      'POST /account/mfa/setup': () =>
        jsonResponse({ secret: 'ABCDEF234567', otpauth_uri: 'otpauth://x', qr: 'data:,' }),
      'POST /account/mfa/confirm': () =>
        jsonResponse({ title: 'Invalid code', detail: 'That code has expired.' }, 400),
    });
    render(<MfaCard />);

    await startSetup(u);
    await u.type(await screen.findByLabelText('Authenticator code'), '000000');
    await u.click(screen.getByRole('button', { name: /enable 2fa/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That code has expired.');
    expect(screen.queryByTestId('backup-codes')).not.toBeInTheDocument();
    expect(setUser).not.toHaveBeenCalled();
  });

  it('abandons enrolment on cancel', async () => {
    const u = userEvent.setup();
    mockApi({
      'POST /account/mfa/setup': () =>
        jsonResponse({ secret: 'ABCDEF234567', otpauth_uri: 'otpauth://x', qr: 'data:,' }),
    });
    render(<MfaCard />);

    await startSetup(u);
    await u.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(screen.queryByAltText('TOTP QR code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set up two-factor/i })).toBeInTheDocument();
  });

  describe('once enabled', () => {
    const enabled = (over: Record<string, unknown> = {}) =>
      jsonResponse({
        enabled: true,
        confirmed_at: '2026-01-01T00:00:00Z',
        backup_codes_remaining: 1,
        required: false,
        can_enroll: true,
        ...over,
      });

    it('counts a single remaining backup code in the singular', async () => {
      mockApi({ 'GET /account/mfa': () => enabled() });
      render(<MfaCard />);
      expect(await screen.findByTestId('mfa-backup-remaining')).toHaveTextContent('1 backup code remaining.');
    });

    it('asks for the password before regenerating rather than calling the API', async () => {
      const u = userEvent.setup();
      const fetchSpy = mockApi({ 'GET /account/mfa': () => enabled() });
      render(<MfaCard />);

      await u.click(await screen.findByRole('button', { name: /regenerate backup codes/i }));

      // R30 — this used to be a banner at the top of the card; it now sits
      // beside the box it is about.
      expect(await screen.findByText('Password is required.')).toBeInTheDocument();
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('backup-codes'))).toHaveLength(0);
    });

    it('regenerates backup codes and clears the password it used', async () => {
      const u = userEvent.setup();
      mockApi({
        'GET /account/mfa': () => enabled({ backup_codes_remaining: 8 }),
        'POST /account/mfa/backup-codes': () => jsonResponse({ backup_codes: ['EEEE-FFFF'] }),
      });
      render(<MfaCard />);

      await u.type(await screen.findByLabelText('Password'), 'hunter2');
      await u.click(screen.getByRole('button', { name: /regenerate backup codes/i }));

      expect(await screen.findByText('EEEE-FFFF')).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toHaveValue('');
    });

    it('reports a regeneration the server refused', async () => {
      const u = userEvent.setup();
      mockApi({
        'GET /account/mfa': () => enabled(),
        'POST /account/mfa/backup-codes': () =>
          jsonResponse({ title: 'Forbidden', detail: 'That password is wrong.' }, 403),
      });
      render(<MfaCard />);

      await u.type(await screen.findByLabelText('Password'), 'nope');
      await u.click(screen.getByRole('button', { name: /regenerate backup codes/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('That password is wrong.');
    });

    it('disables 2FA with the password and tells the session it is off', async () => {
      const u = userEvent.setup();
      let off = false;
      mockApi({
        'GET /account/mfa': () => (off ? jsonResponse(disabledBody) : enabled()),
        'POST /account/mfa/disable': () => {
          off = true;
          return jsonResponse({ ok: true });
        },
      });
      render(<MfaCard />);

      await u.type(await screen.findByLabelText('Password'), 'hunter2');
      await u.click(screen.getByRole('button', { name: /disable 2fa/i }));

      await waitFor(() => expect(screen.getByTestId('mfa-state')).toHaveTextContent('Disabled'));
      expect(setUser).toHaveBeenCalledWith(expect.objectContaining({ totp_enabled: false }));
    });

    it('reports a refused disable and leaves 2FA on', async () => {
      const u = userEvent.setup();
      mockApi({
        'GET /account/mfa': () => enabled(),
        'POST /account/mfa/disable': () =>
          jsonResponse({ title: 'Forbidden', detail: 'Password did not match.' }, 403),
      });
      render(<MfaCard />);

      await u.type(await screen.findByLabelText('Password'), 'wrong');
      await u.click(screen.getByRole('button', { name: /disable 2fa/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Password did not match.');
      expect(screen.getByTestId('mfa-state')).toHaveTextContent('Enabled');
    });

    it('offers no way to turn 2FA off when the organization requires it', async () => {
      mockApi({ 'GET /account/mfa': () => enabled({ required: true }) });
      render(<MfaCard />);

      expect(await screen.findByText(/organization requires two-factor/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /disable 2fa/i })).not.toBeInTheDocument();
    });

    it('downloads the backup codes as a text file', async () => {
      const u = userEvent.setup();
      mockApi({
        'GET /account/mfa': () => enabled(),
        'POST /account/mfa/backup-codes': () => jsonResponse({ backup_codes: ['1111-2222', '3333-4444'] }),
      });
      // jsdom implements neither half of the object-URL pair.
      const createUrl = vi.fn((_blob: Blob) => 'blob:codes');
      const revokeUrl = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: revokeUrl, configurable: true });
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      render(<MfaCard />);

      await u.type(await screen.findByLabelText('Password'), 'hunter2');
      await u.click(screen.getByRole('button', { name: /regenerate backup codes/i }));
      await u.click(await screen.findByRole('button', { name: /download codes/i }));

      expect(click).toHaveBeenCalled();
      const blob = createUrl.mock.calls[0]![0];
      await expect(readBlob(blob)).resolves.toContain('1111-2222');
      expect(revokeUrl).toHaveBeenCalledWith('blob:codes');
    });
  });
});

const disabledBody = {
  enabled: false,
  confirmed_at: null,
  backup_codes_remaining: 0,
  required: false,
  can_enroll: true,
};
