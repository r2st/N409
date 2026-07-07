import { useNavigate } from 'react-router-dom';
import { tokenExpiry } from '../lib/api';
import { useAuth } from '../lib/auth';
import { canManageUsers, isOps, isPartner, scopeLabel } from '../lib/rbac';
import { displayName, formatDateTime, initials } from '../lib/format';
import { Button } from '../components/ui';

export function SettingsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;

  const exp = tokenExpiry();
  const accessTag = isOps(user) ? 'Operations' : isPartner(user) ? 'Partner' : 'Client';

  return (
    <div className="max-w-2xl">
      <div className="overline text-ink-400">Account</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Settings</h1>

      <section className="mt-8 rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-bond-700 text-lg font-bold text-paper-50">
            {initials(user)}
          </div>
          <div>
            <div className="font-display text-xl font-semibold text-ink-900">{displayName(user)}</div>
            <div className="text-sm text-ink-400">{user.email}</div>
          </div>
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-paper-200 pt-6 sm:grid-cols-3">
          <div>
            <dt className="overline text-ink-400">Access</dt>
            <dd className="mt-1 text-sm text-ink-900">{accessTag}</dd>
          </div>
          <div>
            <dt className="overline text-ink-400">Data scope</dt>
            <dd className="mt-1 text-sm text-ink-900">{scopeLabel(user)}</dd>
          </div>
          <div>
            <dt className="overline text-ink-400">Sign-in</dt>
            <dd className="mt-1 text-sm text-ink-900">
              {user.sso_provider === 'google' ? 'Google SSO' : 'Email & password'}
            </dd>
          </div>
          <div>
            <dt className="overline text-ink-400">Email verified</dt>
            <dd className="mt-1 text-sm text-ink-900">{user.verified ? 'Yes' : 'Not yet'}</dd>
          </div>
          {user.partner_id && (
            <div>
              <dt className="overline text-ink-400">Partner</dt>
              <dd className="tnum mt-1 text-sm text-ink-900">{user.partner_id}</dd>
            </div>
          )}
          <div>
            <dt className="overline text-ink-400">Session expires</dt>
            <dd className="tnum mt-1 text-sm text-ink-900">{exp ? formatDateTime(new Date(exp).toISOString()) : '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-6 rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <h2 className="overline mb-4 text-ink-400">Roles</h2>
        <div className="flex flex-wrap gap-2">
          {user.roles.map((r) => (
            <span
              key={r}
              className="rounded-full border border-ink-200 bg-paper-50 px-3 py-1 font-mono text-xs font-semibold text-ink-700"
            >
              {r}
            </span>
          ))}
          {user.roles.length === 0 && <span className="text-sm text-ink-400">No roles assigned.</span>}
        </div>
        {canManageUsers(user) && (
          <p className="mt-4 text-sm text-ink-400">
            You can administer users, roles and partners. The admin console ships in a later milestone.
          </p>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <h2 className="overline mb-2 text-ink-400">Session</h2>
        <p className="mb-4 text-sm text-ink-400">
          Signing out clears the session token from this browser.
        </p>
        <Button
          variant="danger"
          onClick={() => {
            logout();
            navigate('/login');
          }}
        >
          Sign out
        </Button>
      </section>
    </div>
  );
}
