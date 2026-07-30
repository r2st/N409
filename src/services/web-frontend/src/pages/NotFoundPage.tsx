import { Link, useLocation } from 'react-router-dom';

/**
 * Real 404 page (audit F-1 P2). Previously any unknown URL silently redirected
 * to "/", which hid broken links and disoriented users mid-workflow. This states
 * what happened and offers a way back without guessing the user's role.
 */
export function NotFoundPage() {
  const location = useLocation();
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16 text-center">
      <p className="font-mono text-sm font-semibold tracking-wide text-bond-600 uppercase">404</p>
      <h1 className="mt-3 font-display text-3xl font-semibold text-ink-900">Page not found</h1>
      <p className="mt-3 max-w-md text-sm text-ink-500">
        We couldn't find{' '}
        <code className="rounded bg-paper-200 px-1.5 py-0.5 text-ink-700">{location.pathname}</code>. The link
        may be broken or the page may have moved.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          to="/"
          className="inline-flex items-center rounded-md bg-bond-600 px-4 py-2 text-sm font-semibold text-bond-fg transition-colors hover:bg-bond-700"
        >
          Back to home
        </Link>
        <Link
          to="/help"
          className="inline-flex items-center rounded-md border border-ink-200 bg-surface px-4 py-2 text-sm font-semibold text-ink-800 transition-colors hover:border-ink-400"
        >
          Visit help
        </Link>
      </div>
    </main>
  );
}
