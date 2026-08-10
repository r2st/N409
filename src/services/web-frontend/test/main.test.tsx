import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

/**
 * The application bootstrap.
 *
 * `main.tsx` is nine lines of JSX and every one of them is a provider that the
 * rest of the app takes for granted — router, helmet, consent, auth, branding —
 * plus the top-level error boundary that stands between a render throw and a
 * white screen. Nothing else in the suite mounts them together, so a provider
 * dropped or reordered here would ship silently. This test mounts the real
 * entry point against a real DOM root.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function bootstrap() {
  vi.resetModules();
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  await import('../src/main');
  return root;
}

describe('application bootstrap', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Anonymous session, no branding overrides — the cold-start path.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('/branding')
        ? jsonResponse({ branding: null })
        : jsonResponse({ status: 401 }, 401),
    );
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    document.getElementById('root')?.remove();
    window.history.replaceState(null, '', '/');
  });

  it('mounts the app into #root', async () => {
    const root = await bootstrap();
    await waitFor(() => expect(root.childElementCount).toBeGreaterThan(0));
  });

  it('renders a route through the router it installs', async () => {
    // The landing page only renders if BrowserRouter, the Suspense boundary and
    // the lazy route chunks all resolve — i.e. if the bootstrap is wired up.
    await bootstrap();
    await waitFor(() => expect(document.querySelectorAll('a[href]').length).toBeGreaterThan(0), {
      timeout: 5000,
    });
  });

  it('installs the head manager, so page titles are settable', async () => {
    await bootstrap();
    await waitFor(() => expect(document.title).not.toBe(''), { timeout: 5000 });
  });

  it('offers the cookie choice to a visitor who has not made one', async () => {
    await bootstrap();
    expect(await screen.findByRole('dialog', { name: /cookie/i }, { timeout: 5000 })).toBeInTheDocument();
  });
});
