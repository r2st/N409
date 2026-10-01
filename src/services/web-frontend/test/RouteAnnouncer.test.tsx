import { describe, expect, it } from 'vitest';
import { Suspense, lazy } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelmetProvider } from 'react-helmet-async';
import { Link, MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { RouteAnnouncer } from '../src/components/RouteAnnouncer';
import { RouteTitleProvider } from '../src/components/RouteTitle';
import { Seo } from '../src/components/Seo';

/**
 * A `pushState` is not a page load, so nothing announces the new page. The
 * title fixes the tab strip; this is what makes the change audible.
 */

function app(entry: string) {
  return (
    <HelmetProvider>
      <MemoryRouter initialEntries={[entry]}>
        <RouteTitleProvider>
          <RouteAnnouncer />
          <Routes>
            <Route
              path="/dashboard"
              element={
                <>
                  <Link to="/admin/jobs">Background jobs</Link>
                  <Link to="/pricing">Pricing</Link>
                </>
              }
            />
            <Route path="/admin/jobs" element={<p>jobs</p>} />
            <Route
              path="/pricing"
              element={
                <>
                  <Seo title="Pricing" description="What a 409A costs." path="/pricing" />
                  <p>pricing</p>
                </>
              }
            />
          </Routes>
        </RouteTitleProvider>
      </MemoryRouter>
    </HelmetProvider>
  );
}

/** The announcer is the only `sr-only` status region in these renders. */
const region = () => screen.getByRole('status');

describe('RouteAnnouncer', () => {
  it('is present and silent on the first location', async () => {
    // Two properties in one. The region must exist from the first render — a
    // live region inserted with its content already in place is routinely not
    // announced, because what assistive technology watches is a change inside a
    // region it was already tracking. And it must say nothing here: the browser
    // has just loaded a document and read its title.
    render(app('/dashboard'));
    await waitFor(() => expect(document.title).toBe('Dashboard · DoAide 409A'));
    expect(region()).toHaveAttribute('aria-live', 'polite');
    expect(region()).toHaveTextContent('');
  });

  it('announces the page a navigation landed on', async () => {
    render(app('/dashboard'));
    await waitFor(() => expect(document.title).toBe('Dashboard · DoAide 409A'));

    await userEvent.click(screen.getByRole('link', { name: 'Background jobs' }));
    expect(await screen.findByText('jobs')).toBeInTheDocument();
    await waitFor(() => expect(region()).toHaveTextContent('Background jobs'));
  });

  it('drops the brand suffix it would otherwise repeat every time', async () => {
    render(app('/dashboard'));
    await userEvent.click(screen.getByRole('link', { name: 'Background jobs' }));
    await waitFor(() => expect(region()).toHaveTextContent('Background jobs'));
    expect(region().textContent).toBe('Background jobs');
  });

  it('announces a marketing page, whose title comes from <Seo> and not the registry', async () => {
    // The reason the text is read from `document.title` rather than from the
    // route-title registry: the registry deliberately has no title for these.
    render(app('/dashboard'));
    await waitFor(() => expect(document.title).toBe('Dashboard · DoAide 409A'));

    await userEvent.click(screen.getByRole('link', { name: 'Pricing' }));
    expect(await screen.findByText('pricing')).toBeInTheDocument();
    await waitFor(() => expect(region().textContent).toBe('Pricing'));
  });

  it('announces the destination once, not each step of a redirect through it', async () => {
    /*
     * `/` redirects to the dashboard or the partner portal depending on who is
     * signed in, and a guard sends an unauthenticated visitor to the sign-in
     * page. Each of those is two locations in quick succession, and a polite
     * region *queues* — so announcing on every commit reads out the pass-through
     * before the page, and the user waits through an announcement for a page
     * that was never shown.
     *
     * The announcement is scheduled rather than made, and a location that is
     * superseded before the turn is up cancels its own.
     */
    render(
      <HelmetProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          <RouteTitleProvider>
            <RouteAnnouncer />
            <Routes>
              <Route path="/dashboard" element={<Link to="/pass-through">Somewhere</Link>} />
              <Route path="/pass-through" element={<Navigate to="/admin/jobs" replace />} />
              <Route path="/admin/jobs" element={<p>jobs</p>} />
            </Routes>
          </RouteTitleProvider>
        </MemoryRouter>
      </HelmetProvider>,
    );
    await waitFor(() => expect(document.title).toBe('Dashboard · DoAide 409A'));

    await userEvent.click(screen.getByRole('link', { name: 'Somewhere' }));
    expect(await screen.findByText('jobs')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Background jobs'));

    // `/pass-through` is unrouted, so it is titled "Page not found" — the exact
    // string an announcement per commit would have read out on the way past.
    expect(screen.getByRole('status').textContent).not.toContain('not found');
  });

  it('announces the destination of a lazy route, once it is on screen', async () => {
    /*
     * Every route in this application is code-split. React Router runs a
     * navigation as a transition, so the previous page stays up while the chunk
     * is fetched and the location, the title and the page all commit together —
     * which is what lets the announcement be read from `document.title` at the
     * moment the location changes. Asserted rather than assumed: if a chunk
     * fetch ever did commit the location ahead of the page, this announces the
     * page the user left, which is worse than silence.
     */
    let resolveChunk: () => void = () => {};
    const Slow = lazy(
      () =>
        new Promise<{ default: () => React.JSX.Element }>((resolve) => {
          resolveChunk = () => resolve({ default: () => <p>jobs</p> });
        }),
    );

    render(
      <HelmetProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          {/* The shell's arrangement: the boundary is above the announcer. */}
          <Suspense fallback={<p>loading</p>}>
            <RouteTitleProvider>
              <RouteAnnouncer />
              <Routes>
                <Route path="/dashboard" element={<Link to="/admin/jobs">Background jobs</Link>} />
                <Route path="/admin/jobs" element={<Slow />} />
              </Routes>
            </RouteTitleProvider>
          </Suspense>
        </MemoryRouter>
      </HelmetProvider>,
    );
    await waitFor(() => expect(document.title).toBe('Dashboard · DoAide 409A'));

    await userEvent.click(screen.getByRole('link', { name: 'Background jobs' }));
    expect(screen.getByRole('status').textContent).toBe('');

    resolveChunk();
    expect(await screen.findByText('jobs')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Background jobs'));
  });
});
