import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelmetProvider } from 'react-helmet-async';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { ROUTE_TITLES, titleForPath } from '../src/lib/pageTitles';
import { RouteTitleProvider, usePageTitleDetail } from '../src/components/RouteTitle';

/** Package-root relative, as the other source censuses in this suite read. */
const read = (rel: string) => readFileSync(join('src', rel), 'utf8');

/**
 * The route table, as App.tsx actually declares it.
 *
 * Reading the source rather than importing the component is what makes this a
 * census: a route added to App.tsx is found here whether or not anyone thought
 * about its title, which is the entire failure mode — ninety routes drifted
 * into sharing one title precisely because nothing was counting them.
 *
 * Most paths are absolute. The workspace tabs are declared relative, under a
 * single `<Route path="/valuations/:id">` element, so they are resolved against
 * that base — and the span of that block is derived from the file rather than
 * assumed, so a second nested block anywhere would show up as an unresolved
 * relative path rather than being silently attributed to the wrong parent.
 */
function declaredRoutePaths(): string[] {
  const src = read('App.tsx');
  const lines = src.split('\n');
  const NEST_BASE = '/valuations/:id';

  // The line that opens the nested block, and the line that closes it.
  const openIdx = lines.findIndex((l) => l.includes(`path="${NEST_BASE}"`));
  expect(openIdx, 'App.tsx no longer declares the /valuations/:id block').toBeGreaterThan(-1);
  const closeIdx = lines.findIndex((l, i) => i > openIdx && l.trim() === '</Route>');
  expect(closeIdx, 'the /valuations/:id block is not closed').toBeGreaterThan(openIdx);

  const paths: string[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/path="([^"]+)"/g)) {
      const raw = m[1]!;
      if (raw.startsWith('/') || raw === '*') {
        paths.push(raw);
        continue;
      }
      // Relative — only legitimate inside the one nested block.
      expect(i > openIdx && i < closeIdx, `relative route "${raw}" is outside the ${NEST_BASE} block`).toBe(
        true,
      );
      paths.push(`${NEST_BASE}/${raw}`);
    }
  });
  return paths;
}

describe('page titles (WCAG 2.4.2)', () => {
  it('finds the route table at all', () => {
    // The guard against a census that passes by having nothing to examine: a
    // regex that stops matching reports a clean run and a complete registry.
    const paths = declaredRoutePaths();
    expect(paths.length).toBeGreaterThan(100);
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/valuations/:id/cap-table');
    expect(paths).toContain('*');
  });

  it('gives every declared route a title', () => {
    const missing = declaredRoutePaths().filter((p) => !(p in ROUTE_TITLES));
    expect(missing).toEqual([]);
  });

  it('has no registry entry for a route that does not exist', () => {
    // The other direction: a renamed route leaves a title behind that can never
    // be reached, and the coverage check above still passes.
    const declared = new Set(declaredRoutePaths());
    const orphans = Object.keys(ROUTE_TITLES).filter((p) => !declared.has(p));
    expect(orphans).toEqual([]);
  });

  it('titles every application route and defers on every marketing one', () => {
    for (const [path, title] of Object.entries(ROUTE_TITLES)) {
      if (title === null) continue;
      expect(title.trim(), `${path} has a blank title`).not.toBe('');
    }
    // Marketing pages carry `<Seo>`, which owns description/canonical/OG as
    // well; a second <title> here would compete with it.
    expect(titleForPath('/pricing')).toBeNull();
    expect(titleForPath('/blog/some-post')).toBeNull();
    expect(titleForPath('/dashboard')).toBe('Dashboard');
  });

  it('ranks a static segment above a dynamic one', () => {
    // `/valuations/new` matches `/valuations/:id` too. If the title disagreed
    // with the router about which route won, the page would be titled after a
    // valuation that does not exist.
    expect(titleForPath('/valuations/new')).toBe('New valuation');
    expect(titleForPath('/valuations/compare')).toBe('Side-by-side comparison');
    expect(titleForPath('/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('Overview');
    expect(titleForPath('/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV/cap-table')).toBe('Cap Table');
    expect(titleForPath('/admin/partners')).toBe('Partners');
    expect(titleForPath('/admin/partners/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('Partner');
  });

  it('titles an unrouted URL as the page it renders', () => {
    expect(titleForPath('/no/such/place')).toBe('Page not found');
  });

  it('agrees with the sidebar about what each destination is called', () => {
    /*
     * The title a user reads in the tab strip and the label they clicked to get
     * there should be the same words. Two vocabularies for one destination is
     * not a bug a screenshot shows, and it is exactly what happens when the
     * registry is edited without looking at the nav.
     */
    const nav = read('components/AppLayout.tsx');
    const pairs = [...nav.matchAll(/<NavItem\s+to="([^"]+)"\s+label="([^"]+)"/g)].map((m) => ({
      to: m[1]!,
      label: m[2]!,
    }));
    expect(pairs.length).toBeGreaterThan(25);
    const mismatched = pairs
      .filter(({ to }) => !to.includes('?'))
      .map(({ to, label }) => ({ to, label, title: titleForPath(to) }))
      .filter((p) => p.title !== p.label);
    expect(mismatched).toEqual([]);
  });
});

/** Renders the provider at `path` and reports what it put in `document.title`. */
function renderAt(path: string, children?: React.ReactNode) {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>
        <RouteTitleProvider>
          <Routes>
            <Route path="*" element={<>{children ?? null}</>} />
          </Routes>
        </RouteTitleProvider>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe('RouteTitle', () => {
  it('sets the document title from the registry', async () => {
    renderAt('/admin/jobs');
    await waitFor(() => expect(document.title).toBe('Background jobs · DoAide 409A'));
  });

  it('leaves the title to the page on a marketing route', async () => {
    document.title = 'left alone';
    renderAt('/pricing');
    // Nothing to wait for — assert the absence survives a flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(document.title).toBe('left alone');
  });

  it('appends a detail the page supplies', async () => {
    function Detailed() {
      usePageTitleDetail('Acme Robotics, Inc.');
      return <p>workspace</p>;
    }
    renderAt('/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV/cap-table', <Detailed />);
    expect(await screen.findByText('workspace')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Cap Table · Acme Robotics, Inc. · DoAide 409A'));
  });

  it('clears the detail when the page that offered it goes away', async () => {
    // Otherwise the tab keeps naming a valuation the user has navigated off —
    // the detail outlives the only page that could vouch for it.
    function Detailed() {
      usePageTitleDetail('Acme Robotics, Inc.');
      return <Link to="/dashboard">Valuations</Link>;
    }
    render(
      <HelmetProvider>
        <MemoryRouter initialEntries={['/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV']}>
          <RouteTitleProvider>
            <Routes>
              <Route path="/valuations/:id" element={<Detailed />} />
              <Route path="/dashboard" element={<p>dashboard</p>} />
            </Routes>
          </RouteTitleProvider>
        </MemoryRouter>
      </HelmetProvider>,
    );
    await waitFor(() => expect(document.title).toBe('Overview · Acme Robotics, Inc. · DoAide 409A'));

    await userEvent.click(screen.getByRole('link', { name: 'Valuations' }));
    expect(await screen.findByText('dashboard')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Dashboard · DoAide 409A'));
  });
});
