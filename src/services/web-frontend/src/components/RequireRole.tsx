import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { effectiveUser } from '../lib/rbac';
import type { User } from '../lib/types';

/**
 * P1 #5 — role-based routing. The API already enforces the real policy
 * (auth/rbac.ts); this keeps clients from loading admin page shells that
 * would only render raw 403s.
 */

export function AccessDenied() {
  return (
    <div className="mx-auto max-w-md py-16 text-center" role="alert">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-paper-200 text-ink-400">
        <svg
          aria-hidden="true"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <rect x="5" y="10.5" width="14" height="10" rx="1.5" />
          <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" strokeLinecap="round" />
        </svg>
      </div>
      <h1 className="mt-5 font-display text-2xl font-semibold text-ink-900">Access denied</h1>
      <p className="mt-2 text-sm text-ink-500">
        Your account doesn&rsquo;t have permission to view this page.
      </p>
      <Link
        to="/dashboard"
        className="mt-6 inline-block text-sm font-semibold text-bond-600 hover:text-bond-700"
      >
        ← Back to the dashboard
      </Link>
    </div>
  );
}

/**
 * Route guard: renders its children (or the nested routes) only when the
 * predicate passes for the signed-in user. Use as a layout route:
 *   <Route element={<RequireRole allow={isOps} />}> …ops routes… </Route>
 */
export function RequireRole({
  allow,
  children,
}: {
  allow: (user: User | null) => boolean;
  children?: ReactNode;
}) {
  const { user, viewMode } = useAuth();
  // Gate on the effective user so an admin previewing "normal view" is held to
  // the same route guards a client would be. The API still enforces real roles.
  if (!allow(effectiveUser(user, viewMode))) return <AccessDenied />;
  return children ? <>{children}</> : <Outlet />;
}
