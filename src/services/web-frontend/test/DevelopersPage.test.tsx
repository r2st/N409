import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter } from 'react-router-dom';
import { DevelopersPage } from '../src/pages/marketing/DevelopersPage';
import { PARTNER_API, WEBHOOK_EVENTS } from '../src/lib/marketingContent';
import { pageMeta } from '../src/lib/pageMeta';
import { marketingRoutes } from '../src/lib/routes';

/**
 * `/developers` — the partner API docs, in public.
 *
 * The reference has always been rendered from the server's route registry, so
 * it cannot drift. What it could not do was be read: it sat behind RequireAuth,
 * and an engineer evaluating the integration had to sign up to see whether the
 * API had the endpoints they needed.
 *
 * The assertion that matters here is that the page still says something without
 * the fetch. The endpoint table needs a live server; a crawler and a first-time
 * reader do not have one, and a page that renders a spinner to both is not
 * documentation.
 */

const mount = () =>
  render(
    <HelmetProvider>
      <MemoryRouter>
        <DevelopersPage />
      </MemoryRouter>
    </HelmetProvider>,
  );

describe('developers page: registration', () => {
  it('is in the sitemap with head metadata', () => {
    expect(marketingRoutes().map((r) => r.path)).toContain('/developers');
    const meta = pageMeta('/developers')!;
    expect(meta.title).toMatch(/API/i);
    expect(meta.description.length).toBeGreaterThan(80);
  });
});

describe('developers page: content without a server', () => {
  it('documents auth, idempotency, webhooks, rate limits and errors with the API unreachable', () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    mount();

    for (const heading of ['Your first call', 'Idempotency', 'Webhooks', 'Rate limits', 'Errors']) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
    vi.restoreAllMocks();
  });

  it('names every webhook event the platform actually emits', () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    mount();
    for (const event of WEBHOOK_EVENTS) {
      expect(screen.getByText(event.name)).toBeInTheDocument();
    }
    vi.restoreAllMocks();
  });

  it('publishes the signature scheme a receiver has to implement', () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    mount();
    // The header name and the HMAC construction are what a partner writes code
    // against; a doc that mentions "signed webhooks" and not these is useless.
    expect(screen.getAllByText(PARTNER_API.signatureHeader).length).toBeGreaterThan(0);
    expect(screen.getByText(/hmac\.new/i)).toBeInTheDocument();
    expect(screen.getByText(/compare_digest/i)).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('states the full retry ladder rather than "we retry"', () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const { container } = mount();
    const text = container.textContent ?? '';
    for (const step of PARTNER_API.retryLadder) expect(text).toContain(step);
    // Attempts = the initial one plus a step each.
    expect(text).toContain(`${PARTNER_API.retryLadder.length + 1} attempts in total`);
    vi.restoreAllMocks();
  });

  it('links the OpenAPI document and the partner programme', () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    mount();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(PARTNER_API.openApiUrl);
    expect(hrefs).toContain('/partners');
    vi.restoreAllMocks();
  });
});

describe('developers page: the live reference', () => {
  it('renders the endpoints the server reports', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'N409 Partner API',
          version: 'v1',
          base_url: PARTNER_API.prefix,
          authentication: {
            scheme: 'bearer',
            header: `Authorization: Bearer ${PARTNER_API.keyPrefix}…`,
            note: 'Create and revoke API keys in partner settings.',
          },
          rate_limit: { limit: 120, window_seconds: 60, headers: ['x-ratelimit-limit'] },
          endpoints: [
            {
              method: 'POST',
              path: '/valuations',
              summary: 'Create a valuation for your partner organization.',
              auth: 'api_key',
              response: '201 { valuation }',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    mount();
    expect(await screen.findByText('Create a valuation for your partner organization.')).toBeInTheDocument();
    expect(screen.getByText(`${PARTNER_API.prefix}/valuations`)).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
