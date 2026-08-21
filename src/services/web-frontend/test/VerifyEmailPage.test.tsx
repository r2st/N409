import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VerifyEmailPage } from '../src/pages/VerifyEmailPage';

/**
 * Gap #26 — confirming an email from a mailed link. Verification runs on load,
 * so the tests are about where the token is read from, that it is scrubbed from
 * the URL, and that each outcome tells the reader what to do next.
 */

const TOKEN = 'vt_01N409VERIFYTOKEN000000000';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

interface Call {
  url: string;
  body: unknown;
}

function mockApi(respond: () => Response = () => jsonResponse({ status: 'verified', message: 'ok' })) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return respond();
  });
  return calls;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <VerifyEmailPage />
    </MemoryRouter>,
  );

describe('VerifyEmailPage', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('verifies with the token from the URL fragment and scrubs it from the URL', async () => {
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    const calls = mockApi();
    renderPage();

    expect(await screen.findByText(/your email address has been verified/i)).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/v1/auth/verify-email');
    expect(calls[0]!.body).toEqual({ token: TOKEN });
    // The token is a single-use credential — it must not survive in history.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/verify-email');
  });

  it('accepts a ?token= query param as a fallback and scrubs that too', async () => {
    window.history.replaceState(null, '', `/verify-email?token=${TOKEN}`);
    const calls = mockApi();
    renderPage();

    await screen.findByText(/your email address has been verified/i);
    expect(calls[0]!.body).toEqual({ token: TOKEN });
    expect(window.location.search).toBe('');
  });

  it('prefers the fragment over the query string', async () => {
    window.history.replaceState(null, '', `/verify-email?token=from-query#token=${TOKEN}`);
    const calls = mockApi();
    renderPage();

    await screen.findByText(/your email address has been verified/i);
    expect(calls[0]!.body).toEqual({ token: TOKEN });
  });

  it('shows a spinner while the round trip is in flight', () => {
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    mockApi();
    renderPage();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Verifying your email' })).toBeInTheDocument();
  });

  it('reassures a reader who clicked an already-used link a second time', async () => {
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    mockApi(() => jsonResponse({ status: 'already_verified', message: 'ok' }));
    renderPage();

    expect(await screen.findByText(/was already verified/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Email verified' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue to sign in' })).toHaveAttribute('href', '/login');
  });

  it('explains an arrival with no token and does not call the API', async () => {
    window.history.replaceState(null, '', '/verify-email');
    const calls = mockApi();
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Verification link invalid' })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/login');
  });

  it('surfaces the server’s reason for a rejected token and how to recover', async () => {
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    mockApi(() => problem(400, 'This verification link has expired.'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('This verification link has expired.');
    expect(screen.getByText(/expire after 24 hours and can be used once/i)).toBeInTheDocument();
  });

  it('falls back to a generic message when the network fails', async () => {
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong — please try again.');
  });
});
