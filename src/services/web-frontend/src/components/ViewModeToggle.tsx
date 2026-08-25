import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';

/**
 * Routes that only ops/admins can reach. Switching to "normal view" while
 * standing on one of these would render <AccessDenied> (RequireRole now gates
 * on the effective user), so we send the admin back to a page they can still
 * see instead of stranding them.
 */
const ELEVATED_ROUTE = /^\/(admin|tasks|templates|schema)(\/|$)|\/sensitivity(\/|$)/;

/**
 * Admin / normal-user view toggle (admin-role-management feature B).
 *
 * A compact sidebar pill that lets an admin preview the platform as a client
 * sees it. It is *only* rendered for real ops/admin users, and — critically —
 * it reads the REAL user (never the effective one), so it stays visible and
 * functional even in "User view", giving the admin a way back.
 */
export function ViewModeToggle({ onNavigate }: { onNavigate?: () => void }) {
  const { user, viewMode, setViewMode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Visibility uses the real roles — the toggle must never hide itself.
  if (!isOps(user)) return null;

  const normal = viewMode === 'normal';
  const toggle = () => {
    const next = normal ? 'admin' : 'normal';
    setViewMode(next);
    onNavigate?.();
    // Don't leave the admin on a route their previewed role can't open.
    if (next === 'normal' && ELEVATED_ROUTE.test(location.pathname)) {
      navigate('/dashboard');
    }
  };

  return (
    <div className="px-3 pt-3">
      <button
        type="button"
        role="switch"
        aria-checked={normal}
        aria-label={`Viewing as ${normal ? 'a normal user' : 'an admin'} — switch to ${
          normal ? 'admin' : 'user'
        } view`}
        onClick={toggle}
        className={`touch:min-h-11 flex w-full cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors ${
          normal
            ? 'border-brass-400 bg-chrome-800/60 text-chrome-fg'
            : 'border-chrome-700 bg-chrome-800/40 text-chrome-dim hover:border-chrome-600 hover:text-chrome-fg'
        }`}
      >
        <span className={normal ? 'text-brass-300' : 'text-chrome-faint'} aria-hidden>
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path
              d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold">{normal ? 'User view' : 'Admin view'}</span>
        </span>
        {/* Toggle switch — on = normal/user view. */}
        <span
          className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
            normal ? 'bg-brass-400' : 'bg-chrome-600'
          }`}
          aria-hidden
        >
          <span
            className={`inline-block h-3 w-3 transform rounded-full bg-chrome-fg transition-transform ${
              normal ? 'translate-x-3.5' : 'translate-x-0.5'
            }`}
          />
        </span>
      </button>
    </div>
  );
}
