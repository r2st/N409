import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { getToken } from '../src/lib/api';
import { ForgotPasswordPage } from '../src/pages/ForgotPasswordPage';
import { ResetPasswordPage } from '../src/pages/ResetPasswordPage';
import { AcceptInvitePage } from '../src/pages/AcceptInvitePage';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderAt(path: string, element: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path={path} element={element} />
          <Route path="/" element={<div>ROLE_LANDING</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('requests a link and shows the no-enumeration confirmation', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/auth/forgot-password')) {
        expect(JSON.parse(String(init?.body))).toEqual({ email: 'ada@acme.com' });
        return jsonResponse({ message: 'ok' }, 202);
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderAt('/forgot-password', <ForgotPasswordPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'ada@acme.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account exists for/)).toBeInTheDocument();
  });
});

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, '', '/reset-password');
  });

  it('shows the invalid state when the token is missing', () => {
    renderAt('/reset-password', <ResetPasswordPage />);
    expect(screen.getByText('Reset link invalid')).toBeInTheDocument();
    expect(screen.getByText('Request a new reset link')).toBeInTheDocument();
  });

  it('reads the fragment token, strips it from the URL, and resets', async () => {
    window.history.replaceState(null, '', '/reset-password#token=secret-token');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/auth/reset-password')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          token: 'secret-token',
          password: 'a-long-new-password-1',
        });
        return jsonResponse({ message: 'ok' });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderAt('/reset-password', <ResetPasswordPage />);
    expect(window.location.hash).toBe('');
    await userEvent.type(screen.getByLabelText(/^New password/), 'a-long-new-password-1');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a-long-new-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText('Password updated')).toBeInTheDocument();
  });

  it('rejects mismatched passwords client-side', async () => {
    window.history.replaceState(null, '', '/reset-password#token=secret-token');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderAt('/reset-password', <ResetPasswordPage />);
    await userEvent.type(screen.getByLabelText(/^New password/), 'a-long-new-password-1');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'different-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    // Beside the confirmation box — the field the user can actually fix —
    // rather than in the banner above the form.
    expect(await screen.findByText("Passwords don't match.")).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute('aria-invalid', 'true');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flags a short password on blur, before the form is submitted', async () => {
    window.history.replaceState(null, '', '/reset-password#token=secret-token');
    vi.spyOn(globalThis, 'fetch');
    renderAt('/reset-password', <ResetPasswordPage />);
    await userEvent.type(screen.getByLabelText(/^New password/), 'short');
    await userEvent.tab();
    expect(await screen.findByText('New password must be at least 10 characters.')).toBeInTheDocument();
  });

  it('clears the mismatch when the first password is changed to agree', async () => {
    window.history.replaceState(null, '', '/reset-password#token=secret-token');
    vi.spyOn(globalThis, 'fetch');
    renderAt('/reset-password', <ResetPasswordPage />);
    const first = screen.getByLabelText(/^New password/);
    await userEvent.type(first, 'a-long-new-password-1');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'different-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText("Passwords don't match.")).toBeInTheDocument();

    await userEvent.clear(first);
    await userEvent.type(first, 'different-password-1');
    expect(screen.queryByText("Passwords don't match.")).not.toBeInTheDocument();
  });

  it('surfaces the API problem for a bad token', async () => {
    window.history.replaceState(null, '', '/reset-password#token=stale-token');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/reset-password'))
        return jsonResponse(
          {
            title: 'Bad Request',
            status: 400,
            detail: 'This reset link is invalid, expired, or already used',
          },
          400,
        );
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderAt('/reset-password', <ResetPasswordPage />);
    await userEvent.type(screen.getByLabelText(/^New password/), 'a-long-new-password-1');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a-long-new-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid, expired/);
  });
});

describe('AcceptInvitePage', () => {
  const invitee = {
    id: 'u2',
    email: 'new@acme.com',
    first_name: 'New',
    last_name: 'Hire',
    verified: true,
    sso_provider: null,
    partner_id: null,
    roles: ['reviewer'],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, '', '/accept-invite');
  });

  it('shows the invalid state for a dead token', async () => {
    window.history.replaceState(null, '', '/accept-invite#token=revoked');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/invite-info'))
        return jsonResponse({ title: 'Bad Request', status: 400 }, 400);
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderAt('/accept-invite', <AcceptInvitePage />);
    expect(await screen.findByText('Invitation not valid')).toBeInTheDocument();
  });

  it('previews the email and signs the invitee straight in', async () => {
    window.history.replaceState(null, '', '/accept-invite#token=invite-token');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/auth/invite-info')) return jsonResponse({ email: 'new@acme.com' });
      if (u.endsWith('/auth/accept-invite')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          token: 'invite-token',
          password: 'invitee-password-1',
        });
        return jsonResponse({ user: invitee, token: 'session-jwt' }, 201);
      }
      if (u.endsWith('/auth/me')) return jsonResponse({ user: invitee });
      throw new Error(`unexpected fetch ${u}`);
    });
    renderAt('/accept-invite', <AcceptInvitePage />);
    expect(await screen.findByText('new@acme.com')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^Password/), 'invitee-password-1');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'invitee-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Create account & sign in' }));
    expect(await screen.findByText('ROLE_LANDING')).toBeInTheDocument();
    expect(getToken()).toBe('session-jwt');
  });
});
