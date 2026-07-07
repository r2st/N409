import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiDocsPage } from '../src/pages/ApiDocsPage';

/** Improvement 6 — API reference rendered from the server's route registry. */

const docs = {
  name: 'N409 Partner API',
  version: 'v1',
  base_url: '/api/partner/v1',
  authentication: {
    scheme: 'bearer',
    header: 'Authorization: Bearer n409_pat_…',
    note: 'Create and revoke API keys in partner settings.',
  },
  rate_limit: {
    limit: 120,
    window_seconds: 60,
    headers: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
  },
  endpoints: [
    {
      method: 'POST',
      path: '/valuations',
      summary: 'Create a valuation for your partner organization.',
      auth: 'api_key',
      body: { kind: 'Valuation kind', company_name: 'Company being valued (required)' },
      response: '201 { valuation }',
    },
    {
      method: 'GET',
      path: '/docs',
      summary: 'This document.',
      auth: 'none',
      response: '{ endpoints[] }',
    },
  ],
};

describe('ApiDocsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders auth, rate limit, and every endpoint from the registry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(docs), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(
      <MemoryRouter>
        <ApiDocsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Authorization: Bearer n409_pat_…')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('/api/partner/v1/valuations')).toBeInTheDocument();
    expect(screen.getByText('Create a valuation for your partner organization.')).toBeInTheDocument();
    expect(screen.getByText('company_name')).toBeInTheDocument();
    expect(screen.getByText('no auth')).toBeInTheDocument();
    // fetched from the un-proxied partner API path
    expect(vi.mocked(globalThis.fetch).mock.calls[0]![0]).toBe('/api/partner/v1/docs');
  });

  it('surfaces a load failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    render(
      <MemoryRouter>
        <ApiDocsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Could not load the API reference.')).toBeInTheDocument();
  });
});
