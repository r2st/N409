import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../src/components/AppLayout';
import { MarketingLayout } from '../src/components/MarketingLayout';
import { StandaloneLayout } from '../src/components/StandaloneLayout';

/**
 * A render error on one page must not cost the user the shell around it.
 *
 * AppLayout already records why the *Suspense* boundary was moved down out of
 * App.tsx — sitting above the router, one lazy chunk fetch "tore the whole
 * shell down and put a spinner on an empty screen: sidebar gone, heading gone".
 * The error boundary was left behind by that move, with the same problem one
 * step worse: a throw anywhere in any page replaced the entire workspace with
 * an error card. Sidebar, all ~30 nav links, and the sign-out button, gone —
 * the only control left being "Reload".
 *
 * Two properties, and the second is the one that is easy to miss: a boundary
 * that has caught an error stays caught, so without a reset the error card
 * outlives the route that produced it and the preserved navigation is useless.
 */

const OPS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    viewMode: 'real',
    logout: vi.fn(),
    user: {
      id: OPS_ID,
      email: 'ops@n409.example',
      first_name: 'Olive',
      last_name: 'Ops',
      verified: true,
      sso_provider: null,
      partner_id: null,
      roles: ['admin'],
    },
  }),
}));

function Boom(): never {
  throw new Error('this page exploded');
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs the caught error; the boundary logs it again on purpose.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ unread_count: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  localStorage.clear();
});

afterEach(() => {
  consoleError.mockRestore();
  vi.restoreAllMocks();
});

function renderApp(initial = '/broken') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/broken" element={<Boom />} />
          <Route path="/dashboard" element={<h1>Dashboard body</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppLayout keeps the shell when a page throws', () => {
  it('shows the error where the page was', () => {
    renderApp();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('leaves the navigation standing', () => {
    renderApp();
    // The whole point: there is still somewhere to go.
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dashboard/ })).toBeInTheDocument();
  });

  it('leaves the sign-out button standing', () => {
    renderApp();
    // Being unable to sign out of a crashed workspace is the worst version of
    // this, especially on a shared machine.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('keeps the skip link and the main landmark', () => {
    renderApp();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
    expect(document.getElementById('main-content')).not.toBeNull();
  });

  it('reports the error rather than losing it', () => {
    renderApp();
    const logged = consoleError.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('this page exploded');
  });

  it('clears the error when the user navigates away', async () => {
    renderApp();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: /Dashboard/ }));

    // Without the remount key the boundary stays caught and the error card
    // survives the navigation, making the preserved nav pointless.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Dashboard body' })).toBeInTheDocument();
  });

  it('does not swallow a healthy page', () => {
    renderApp('/dashboard');
    expect(screen.getByRole('heading', { name: 'Dashboard body' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('MarketingLayout keeps its chrome when a page throws', () => {
  const renderMarketing = (initial = '/broken') =>
    render(
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route element={<MarketingLayout />}>
            <Route path="/broken" element={<Boom />} />
            <Route path="/pricing" element={<h1>Pricing body</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

  it('keeps the header navigation', () => {
    renderMarketing();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('navigation', { name: 'Marketing' })).toBeInTheDocument();
  });

  it('clears the error when the user navigates away', async () => {
    renderMarketing();
    // "Pricing" also appears in the footer; take the one in the header nav.
    const header = screen.getByRole('navigation', { name: 'Marketing' });
    await userEvent.click(within(header).getByRole('link', { name: 'Pricing' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Pricing body' })).toBeInTheDocument();
  });
});

describe('StandaloneLayout catches the pages that have no shell at all', () => {
  /**
   * Sign-in, the password flows, the 404, and the three token-in-the-fragment
   * portals sit under neither layout. Before this they had only the boundary in
   * `main.tsx`, which wraps the router instead of living inside it: it replaces
   * the `Routes` along with the page, so nothing is left to navigate with, and
   * it has no route to key on, so it never resets. A crash on /login was the
   * rest of the tab session.
   */
  const renderStandalone = (initial = '/broken') =>
    render(
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route element={<StandaloneLayout />}>
            <Route path="/broken" element={<Boom />} />
            <Route path="/login" element={<h1>Sign in</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

  it('shows the error instead of a blank document', () => {
    renderStandalone();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('clears the error when the location changes', async () => {
    // The property the root boundary in main.tsx cannot have: it wraps the
    // router, so it has no pathname to key on and stays caught for the life of
    // the tab — a browser Back off a crashed /login lands on the same card.
    // The link here stands in for that navigation; it sits outside the
    // boundary because once the page has thrown, the page is the fallback.
    render(
      <MemoryRouter initialEntries={['/broken']}>
        <Link to="/login">Go to sign in</Link>
        <Routes>
          <Route element={<StandaloneLayout />}>
            <Route path="/broken" element={<Boom />} />
            <Route path="/login" element={<h1>Sign in</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Go to sign in' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('reports the error rather than losing it', () => {
    renderStandalone();
    expect(consoleError.mock.calls.flat().map(String).join(' ')).toContain('this page exploded');
  });

  it('does not swallow a healthy page', () => {
    renderStandalone('/login');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/**
 * The three tests above each prove one layout catches. This proves there is no
 * fourth kind of route that reaches none of them.
 *
 * That is the failure this round found, and it is not one a behavioural test
 * finds: every page it covered did have a boundary, and the ones that did not
 * were the ones nobody had written a crash test for. `/` hand-copied the
 * marketing shell and left the boundary out of the copy; sign-in, the password
 * flows, the 404 and the three token portals had never been under a layout at
 * all. Twelve routes and the busiest anonymous page in the product, all of them
 * falling through to `main.tsx` — which wraps the router rather than sitting
 * inside it, so it takes the `Routes` down with the page and, having no
 * pathname to key on, never resets.
 *
 * So the invariant is structural: inside `<Routes>`, *every* direct child is a
 * pathless layout route, and every one of those layouts puts a keyed
 * `ErrorBoundary` around its `Outlet`. Adding a route at the top level fails
 * this until it is nested under one of them.
 */
describe('no route escapes a per-route boundary', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SRC = path.resolve(HERE, '../src');
  const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

  /**
   * `<Route>` tags in source order with their nesting depth.
   *
   * Attribute-blind regexes are the trap here: an `element={<Foo />}` prop
   * contains a `>`, so `<Route[^>]*>` ends the tag in the middle of it and
   * every depth after that is wrong — which shows up as a census that reads
   * zero top-level routes and passes by having found nothing. Hence walking
   * the tag with brace and quote tracking, and the vacuity guard below.
   */
  function routeTags(text: string): Array<{ depth: number; tag: string }> {
    const out: Array<{ depth: number; tag: string }> = [];
    let i = 0;
    let depth = 0;
    while (i < text.length) {
      if (text.startsWith('</Route>', i)) {
        depth -= 1;
        i += 8;
        continue;
      }
      if (text.startsWith('<Route', i) && !/\w/.test(text[i + 6] ?? '')) {
        let j = i + 6;
        let braces = 0;
        let quote: string | null = null;
        for (; j < text.length; j += 1) {
          const c = text[j]!;
          if (quote) {
            if (c === quote) quote = null;
            continue;
          }
          if (c === '"' || c === "'" || c === '`') quote = c;
          else if (c === '{') braces += 1;
          else if (c === '}') braces -= 1;
          else if (c === '>' && braces === 0) break;
        }
        const tag = text.slice(i, j + 1);
        out.push({ depth, tag: tag.replace(/\s+/g, ' ') });
        if (!/\/\s*>$/.test(tag)) depth += 1;
        i = j + 1;
        continue;
      }
      i += 1;
    }
    return out;
  }

  const app = read('App.tsx');
  const routesBlock = app.slice(app.indexOf('<Routes>') + '<Routes>'.length, app.lastIndexOf('</Routes>'));
  const tags = routeTags(routesBlock);
  const topLevel = tags.filter((t) => t.depth === 0);

  /** The layouts that wrap their `Outlet` in a boundary keyed on the pathname. */
  const BOUNDARY_LAYOUTS = ['AppLayout', 'MarketingLayout', 'StandaloneLayout'];

  it('reads the route table rather than finding nothing to check', () => {
    // Vacuity guard: if the walker above ever mis-parses, it reports an empty
    // or shallow tree, and every assertion below passes for the wrong reason.
    expect(tags.length).toBeGreaterThan(80);
    expect(topLevel.length).toBeGreaterThan(0);
    expect(Math.max(...tags.map((t) => t.depth))).toBeGreaterThanOrEqual(2);
  });

  it('has no top-level route that renders a page directly', () => {
    // A `path` at depth 0 is a page with no layout above it — the shape that
    // put `/login` and `/auditor` outside every boundary.
    expect(topLevel.filter((t) => /\spath=/.test(t.tag)).map((t) => t.tag)).toEqual([]);
  });

  it('routes every top-level branch through a boundary-providing layout', () => {
    const strays = topLevel.filter((t) => !BOUNDARY_LAYOUTS.some((l) => t.tag.includes(`<${l} `)));
    expect(strays.map((t) => t.tag)).toEqual([]);
  });

  it('keeps each of those layouts an actual keyed boundary', () => {
    // The other half: naming a layout above proves nothing if the layout has
    // since stopped wrapping its Outlet, or dropped the remount key.
    for (const layout of BOUNDARY_LAYOUTS) {
      const text = read(`components/${layout}.tsx`);
      expect(text, `${layout} must catch`).toMatch(/<ErrorBoundary\s+key=\{location\.pathname\}/);
    }
  });
});
