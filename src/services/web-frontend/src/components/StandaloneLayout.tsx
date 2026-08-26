import { Outlet, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * The boundary for pages that have no chrome to preserve.
 *
 * Sign-in, the password flows, and the three token-in-the-fragment portals
 * (`/auditor`, `/intake`, `/board-sign`) are full-screen pages: they sit under
 * neither `MarketingLayout` nor `AppLayout`, so until this existed the nearest
 * boundary above them was the last-resort one in `main.tsx`. That one wraps the
 * router rather than living inside it, which has two consequences a page-level
 * boundary does not. It replaces the whole application, including the `Routes`
 * that would render anywhere else to go; and having no route to key on, it
 * cannot reset — once caught, it stays caught for the life of the tab, so even
 * a browser Back lands on the same error card.
 *
 * The portals are the reason this is not theoretical. Each parses a token out
 * of the URL fragment — attacker-reachable input, on a page an outside auditor
 * or a board member reaches from an emailed link and has no account to fall
 * back on.
 *
 * There is no header or sidebar to keep here, so the fallback is the page. What
 * this adds is the remount key: navigating away actually clears the error.
 */
export function StandaloneLayout() {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname} label="this page">
      <Outlet />
    </ErrorBoundary>
  );
}
