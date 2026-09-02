import { useCallback, useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { api, apiDownload, describeActionFailure } from '../lib/api';
import { useLatestOnly } from '../lib/useLatestOnly';
import { useClearOnChange } from '../lib/useClearOnChange';
import { email as emailRule, password as passwordRule, useFormValidation } from '../lib/useFormValidation';
import { PASSWORD_HINT } from '../lib/passwordPolicy';
import { useAuth } from '../lib/auth';
import { canManageUsers, hasPassword } from '../lib/rbac';
import { displayName, formatDate } from '../lib/format';
import type { AdminUser, Invitation, Partner } from '../lib/types';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  ListTruncationNote,
  PickerOverflowNote,
  ResultCount,
  Select,
  SuccessNote,
  TableSkeleton,
  TextInput,
} from '../components/ui';

const PER_PAGE = 25;

/**
 * Roles come from the server (`GET /roles`), not a list in this file.
 *
 * A copy lived here and had already drifted: it was missing `auditor`, so an
 * admin could not filter by it and the checkbox set could not grant it. More
 * to the point, a bare key is not a choice anybody can make well —
 * `data_supervisor` and `support_supervisor` differ by a word — so the catalog
 * carries a label, a description and the capabilities each role actually
 * confers, and this page renders what it is told.
 */
interface RoleDef {
  key: string;
  label: string;
  description: string;
  scope: 'ops' | 'partner' | 'client' | 'none';
  capabilities: string[];
}

interface CapabilityDef {
  key: string;
  label: string;
  description: string;
  roles: string[];
}

const SCOPE_LABELS: Record<RoleDef['scope'], string> = {
  ops: 'Every engagement',
  partner: 'Their firm',
  client: 'Their own',
  none: 'No engagement scope',
};

/**
 * The capability matrix, as a reference table. Collapsed by default: it is the
 * answer to "what does this actually grant", which an admin asks once and then
 * not again for a month.
 */
function RoleMatrix({ roles, capabilities }: { roles: RoleDef[]; capabilities: CapabilityDef[] }) {
  const [open, setOpen] = useState(false);
  if (roles.length === 0) return null;
  return (
    <section className="mt-8 rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="overline text-ink-400">Roles &amp; capabilities</h2>
          <p className="mt-1 text-sm text-ink-400">
            What each of the {roles.length} roles grants. `ignored` is the one that subtracts — it overrides
            every other role a user holds.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </div>
      {open && (
        <div className="mt-4 overflow-x-auto overscroll-x-contain">
          <table className="w-full text-sm" aria-label="Role capability matrix">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline py-2 pr-4 font-semibold text-ink-400">Capability</th>
                {roles.map((r) => (
                  <th
                    key={r.key}
                    className="px-1 py-2 text-center align-bottom text-[0.65rem] font-semibold text-ink-500"
                    title={r.description}
                  >
                    {/* Vertical: eighteen horizontal role names is a table
                        nobody can fit on a screen. */}
                    <span className="inline-block [writing-mode:vertical-rl] rotate-180 whitespace-nowrap">
                      {r.label}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {capabilities.map((c) => (
                <tr key={c.key} className="border-b border-paper-200 last:border-0">
                  <td className="py-2 pr-4">
                    <div className="font-semibold text-ink-800">{c.label}</div>
                    <div className="max-w-md text-xs text-ink-400">{c.description}</div>
                  </td>
                  {roles.map((r) => (
                    <td key={r.key} className="px-1 py-2 text-center">
                      {r.capabilities.includes(c.key) ? (
                        <span className="text-bond-600" aria-label="granted">
                          ●
                        </span>
                      ) : (
                        <span className="text-paper-300" aria-label="not granted">
                          ·
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface UserList {
  users: AdminUser[];
  page: number;
  per_page: number;
  total: number;
}

type EditorState = {
  mode: 'invite' | 'create' | 'edit';
  id?: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  partner_id: string;
  roles: Set<string>;
  /**
   * The administrator's *own* password, not the new account's.
   *
   * Creating an account and inviting one are credential-level actions: the
   * account they produce has its own password and outlives every way of taking
   * the caller's access away, so the server re-authenticates both (R362). Same
   * prompt, same wording and same skip-for-an-SSO-account as the SCIM and SAML
   * mints on the SSO settings page.
   */
  current_password: string;
};

const emptyEditor = (mode: 'invite' | 'create'): EditorState => ({
  mode,
  email: '',
  password: '',
  first_name: '',
  last_name: '',
  partner_id: '',
  roles: new Set(['valuation_user']),
  current_password: '',
});

/** What the rules read while the editor is closed. */
const CLOSED_EDITOR: EditorState = emptyEditor('create');

/** Pending / accepted / revoked / expired, in display terms. */
function invitationStatus(i: Invitation): { label: string; tone: string } {
  if (i.accepted_at) return { label: 'Accepted', tone: 'bg-bond-50 text-bond-700 ring-bond-200' };
  if (i.revoked_at) return { label: 'Revoked', tone: 'bg-paper-200 text-ink-500 ring-ink-200' };
  if (new Date(i.expires_at).getTime() < Date.now())
    return { label: 'Expired', tone: 'bg-amber-50 text-amber-800 ring-amber-200' };
  return { label: 'Pending', tone: 'bg-sky-50 text-sky-800 ring-sky-200' };
}

/** M3 feature 13 — user/role admin console. */
/**
 * Said out-of-band because the CSV cannot say it in-band — the same reasoning,
 * and the same wording, as the valuations export on ValuationsPage.
 */
const EXPORT_CAPPED =
  'The export hit the row cap — it holds the first accounts only. Narrow the filters and export again for the rest.';

export function AdminUsersPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<UserList | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnersCapped, setPartnersCapped] = useState(false);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  /** Confirmation for actions with no visible effect on the table. */
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qDraft, setQDraft] = useState(params.get('q') ?? '');
  const [roleDefs, setRoleDefs] = useState<RoleDef[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityDef[]>([]);
  /*
   * Both catalogs are fetched separately from the user list and both were
   * caught with `.catch(() => {})`, so an outage emptied them — and an empty
   * catalog is not "there are no roles", it is a permission control that has
   * quietly stopped working. The editor's checkboxes are rendered *from* the
   * catalog, so with none there is nothing to tick, no way to revoke, and
   * nothing on screen saying why the box is blank.
   */
  const [roleCatalogFailed, setRoleCatalogFailed] = useState(false);
  const [partnersFailed, setPartnersFailed] = useState(false);
  const [invitationsFailed, setInvitationsFailed] = useState(false);
  const [invitationsCapped, setInvitationsCapped] = useState(false);

  const q = params.get('q') ?? '';
  const role = params.get('role') ?? '';
  const partner = params.get('partner') ?? '';
  const showDeleted = params.get('deleted') === '1';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  /*
   * Five controls feed this one address — the search box, the role and partner
   * pickers, the deleted toggle and the pager — and every one of them re-issues
   * the request without waiting for the reply already outstanding. The slower
   * reply lands second and paints the previous filter's users under the current
   * one, with the pager's total taken from a query nobody is looking at. On a
   * screen whose whole purpose is deciding who has access, that is a list of
   * people someone acts on. See `useLatestOnly`.
   */
  const claim = useLatestOnly();

  const load = useCallback(() => {
    const current = claim();
    setError(null);
    const query = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
    if (q) query.set('q', q);
    if (role) query.set('role', role);
    if (partner) query.set('partner_id', partner);
    if (showDeleted) query.set('include_deleted', 'true');
    api<UserList>(`/users?${query}`)
      .then((d) => current() && setData(d))
      .catch(() => current() && setError('Could not load users.'));
  }, [q, role, partner, showDeleted, page, claim]);

  useEffect(() => {
    load();
  }, [load]);

  /*
   * The listing already renders its own placeholder for a null `data`, so the
   * controls survive the wait — what it did not do is empty `data` when the
   * question changed. Filtering to a role, ticking "include deleted" or paging
   * left the previous set of people on screen underneath the new controls, with
   * the row actions live against every one of them, on the screen whose whole
   * purpose is deciding who has access. See `useClearOnChange`.
   */
  useClearOnChange(`${q}|${role}|${partner}|${showDeleted}|${page}`, () => setData(null));

  useEffect(() => {
    api<{ partners: Partner[]; truncated: boolean }>('/partners')
      .then((res) => {
        setPartners(res.partners);
        setPartnersCapped(res.truncated);
      })
      .catch(() => setPartnersFailed(true));
  }, []);

  // The role catalog. Fetched rather than hard-coded so a role added on the
  // server appears in the filter and the grant list without a second
  // deployment — the copy that lived here had already gone stale.
  useEffect(() => {
    api<{ roles: RoleDef[]; capabilities: CapabilityDef[] }>('/roles')
      .then((res) => {
        setRoleDefs(res.roles);
        setCapabilities(res.capabilities);
      })
      .catch(() => setRoleCatalogFailed(true));
  }, []);

  const loadInvitations = useCallback(() => {
    api<{ invitations: Invitation[]; truncated: boolean }>('/users/invitations')
      .then((res) => {
        setInvitations(res.invitations);
        setInvitationsCapped(res.truncated);
        setInvitationsFailed(false);
      })
      // The section renders behind `invitations.length > 0`, so an outage was
      // not a shorter list — it was no section at all, which reads as "nobody
      // is waiting on an invitation". An admin who believes that sends a
      // second one to somebody who already has a live link.
      .catch(() => setInvitationsFailed(true));
  }, []);

  useEffect(() => {
    loadInvitations();
  }, [loadInvitations]);

  /*
   * The password rule is installed only for `create`. Invite sends a link and
   * the person picks their own; edit does not carry a password at all, and a
   * `minLength` there would refuse every save of an existing user over a box
   * that is not on screen.
   *
   * "At least one role" was a disabled button. An admin who unticked the last
   * role saw the save go dead with the reason two sections up the form, which
   * is where a message next to the roles belongs instead.
   */
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(editor ?? CLOSED_EDITOR, {
    email: emailRule('email'),
    ...(editor?.mode === 'create' ? { password: passwordRule<EditorState>('password') } : {}),
    roles: (values) => (values.roles.size > 0 ? null : 'Pick at least one role.'),
  });

  // The API enforces this too — the redirect just keeps the nav honest.
  if (!canManageUsers(user)) return <Navigate to="/dashboard" replace />;

  /*
   * Whether this administrator has a password to confirm with.
   *
   * The server skips the prompt for an account with no digest — an SSO-only
   * administrator has nothing to type — so asking would be a box nobody can
   * fill. Same read as the SSO settings page's two prompts.
   */
  const needsReauth = hasPassword(user);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next, { replace: true });
  };

  const openEdit = (u: AdminUser) => {
    setEditorError(null);
    setEditor({
      mode: 'edit',
      id: u.id,
      email: u.email,
      password: '',
      first_name: u.first_name ?? '',
      last_name: u.last_name ?? '',
      partner_id: u.partner_id ?? '',
      roles: new Set(u.roles),
      current_password: '',
    });
  };

  const save = handleSubmit(async () => {
    if (!editor) return;
    // Mirrors the API rule: partner/member roles are scoped to an organisation.
    if (!editor.partner_id && ['partner', 'member'].some((r) => editor.roles.has(r))) {
      setEditorError('Partner and member roles require a partner organisation — pick one below.');
      return;
    }
    // Checked here as well as by the server, for the reason every other
    // client-side copy of a server rule exists: a round trip to be told a
    // required box is empty is a worse answer than the box saying so.
    if (editor.mode !== 'edit' && hasPassword(user) && !editor.current_password) {
      setEditorError(
        editor.mode === 'invite'
          ? 'Your current password is required to invite someone.'
          : 'Your current password is required to create an account.',
      );
      return;
    }
    setBusy(true);
    setEditorError(null);
    try {
      if (editor.mode === 'invite') {
        await api('/users/invite', {
          method: 'POST',
          body: {
            email: editor.email.trim(),
            partner_id: editor.partner_id || null,
            roles: [...editor.roles],
            current_password: editor.current_password,
          },
        });
        loadInvitations();
      } else if (editor.mode === 'create') {
        await api('/users', {
          method: 'POST',
          body: {
            email: editor.email.trim(),
            password: editor.password,
            first_name: editor.first_name.trim() || undefined,
            last_name: editor.last_name.trim() || undefined,
            partner_id: editor.partner_id || null,
            roles: [...editor.roles],
            current_password: editor.current_password,
          },
        });
      } else {
        await api(`/users/${editor.id}`, {
          method: 'PATCH',
          body: {
            email: editor.email.trim(),
            first_name: editor.first_name.trim() || null,
            last_name: editor.last_name.trim() || null,
            partner_id: editor.partner_id || null,
            roles: [...editor.roles],
          },
        });
      }
      setEditor(null);
      load();
    } catch (err) {
      setEditorError(describeActionFailure(err, 'Could not save the user.'));
    } finally {
      setBusy(false);
    }
  });

  const remove = async (u: AdminUser) => {
    if (!window.confirm(`Deactivate ${u.email}? They will no longer be able to sign in.`)) return;
    try {
      await api(`/users/${u.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not delete the user.'));
    }
  };

  const restore = async (u: AdminUser) => {
    try {
      await api(`/users/${u.id}/restore`, { method: 'POST' });
      load();
      // Deactivation dropped their roles — take the admin straight to the
      // editor so the account doesn't come back scoped to nothing.
      setEditorError(null);
      setEditor({
        mode: 'edit',
        id: u.id,
        email: u.email,
        password: '',
        first_name: u.first_name ?? '',
        last_name: u.last_name ?? '',
        partner_id: u.partner_id ?? '',
        roles: new Set(['valuation_user']),
        current_password: '',
      });
    } catch (err) {
      setError(describeActionFailure(err, 'Could not restore the user.'));
    }
  };

  /** Support path for a user who can't complete the self-service reset flow. */
  const sendPasswordReset = async (u: AdminUser) => {
    if (!window.confirm(`Email a password reset link to ${u.email}?`)) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ message: string }>(`/users/${u.id}/send-password-reset`, {
        method: 'POST',
      });
      setNotice(res.message);
    } catch (err) {
      setError(describeActionFailure(err, 'Could not send the reset link.'));
    }
  };

  /** Kills the user's session tokens. Their API tokens keep working. */
  const revokeSessions = async (u: AdminUser) => {
    if (!window.confirm(`Sign ${u.email} out of every browser and device?`)) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ message: string }>(`/users/${u.id}/revoke-sessions`, {
        method: 'POST',
      });
      setNotice(res.message);
    } catch (err) {
      setError(describeActionFailure(err, 'Could not sign the user out.'));
    }
  };

  /**
   * One-click promotion (admin-role-management feature A). Additive: the API
   * adds the admin role without touching the user's other roles.
   */
  const promote = async (u: AdminUser) => {
    if (
      !window.confirm(
        `Promote ${displayName(u)} (${u.email}) to admin?\n\n` +
          'They will gain access to user management, partner management, and all operations tools.',
      )
    )
      return;
    setError(null);
    try {
      await api(`/users/${u.id}/promote`, { method: 'POST', body: { role: 'admin' } });
      load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not promote the user.'));
    }
  };

  const demote = async (u: AdminUser) => {
    if (
      !window.confirm(
        `Remove admin access from ${displayName(u)} (${u.email})?\n\n` +
          'They will lose user management, partner management, and operations tools.',
      )
    )
      return;
    setError(null);
    try {
      await api(`/users/${u.id}/demote`, { method: 'POST', body: { role: 'admin' } });
      load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not remove admin access.'));
    }
  };

  const resendInvite = async (i: Invitation) => {
    try {
      await api(`/users/invitations/${i.id}/resend`, { method: 'POST' });
      loadInvitations();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not resend the invitation.'));
    }
  };

  const revokeInvite = async (i: Invitation) => {
    if (!window.confirm(`Revoke the invitation for ${i.email}? The emailed link will stop working.`)) return;
    try {
      await api(`/users/invitations/${i.id}`, { method: 'DELETE' });
      loadInvitations();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not revoke the invitation.'));
    }
  };

  const toggleRole = (key: string) => {
    setEditor((ed) => {
      if (!ed) return ed;
      const roles = new Set(ed.roles);
      if (roles.has(key)) roles.delete(key);
      else roles.add(key);
      return { ...ed, roles };
    });
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PER_PAGE)) : 1;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Administration</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Users &amp; roles</h1>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              const query = new URLSearchParams();
              if (q) query.set('q', q);
              if (role) query.set('role', role);
              if (partner) query.set('partner_id', partner);
              setExportNote(null);
              /*
               * The result was discarded here, and this is the export where
               * that matters most: a user directory is handed to an auditor as
               * "everyone with access", and the accounts past the cap are the
               * ones nobody thinks to look for. The route sets
               * `x-export-truncated` for exactly this; saying it out-of-band is
               * the only option, since a note row in a CSV is data.
               */
              void apiDownload(`/users/export?${query}`, 'users.csv')
                .then(({ truncated }) => {
                  if (truncated) setExportNote(EXPORT_CAPPED);
                })
                .catch((err: unknown) =>
                  setError(describeActionFailure(err, 'The user export was not produced.')),
                );
            }}
          >
            ↓ Export CSV
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setEditorError(null);
              // A partner filter pre-selects that org for the new account.
              setEditor({ ...emptyEditor('create'), partner_id: partner });
            }}
          >
            New user with password
          </Button>
          <Button
            onClick={() => {
              setEditorError(null);
              setEditor({ ...emptyEditor('invite'), partner_id: partner });
            }}
          >
            + Invite user
          </Button>
        </div>
      </div>

      <form
        className="mt-6 flex flex-wrap gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter('q', qDraft.trim());
        }}
      >
        <div className="w-full sm:w-72">
          <TextInput
            aria-label="Search users"
            placeholder="Search email or name…"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            onBlur={() => setFilter('q', qDraft.trim())}
          />
          {/* The whole matching set, not the page of it that is rendered. */}
          <ResultCount count={data ? data.total : null} noun="user" query={q} />
        </div>
        <Select
          aria-label="Filter by role"
          value={role}
          onChange={(e) => setFilter('role', e.target.value)}
          className="!w-auto min-w-36"
        >
          <option value="">All roles</option>
          {roleDefs.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by partner"
          value={partner}
          onChange={(e) => setFilter('partner', e.target.value)}
          className="!w-auto min-w-36"
        >
          <option value="">All partners</option>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <PickerOverflowNote truncated={partnersCapped} />
        </Select>
        <label className="flex cursor-pointer items-center gap-1.5 self-center text-sm text-ink-700">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setFilter('deleted', e.target.checked ? '1' : '')}
            className="accent-bond-600"
          />
          Show deactivated
        </label>
        <button type="submit" hidden />
      </form>

      {/* Create / edit panel */}
      {editor && (
        <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-5 text-ink-400">
            {editor.mode === 'invite'
              ? 'Invite user'
              : editor.mode === 'create'
                ? 'New user'
                : `Edit ${editor.email}`}
          </h2>
          {editor.mode === 'invite' && (
            <p className="-mt-3 mb-5 text-sm text-ink-400">
              We'll email a link that lets them set their own password. It expires after 7 days.
            </p>
          )}
          <form onSubmit={save} className="space-y-5" noValidate>
            {editorError && <ErrorNote>{editorError}</ErrorNote>}
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Email" error={errorFor('email')}>
                <TextInput
                  type="email"
                  required
                  value={editor.email}
                  onChange={(e) => setEditor({ ...editor, email: e.target.value })}
                  onBlur={blurHandler('email')}
                />
              </Field>
              {editor.mode === 'create' && (
                <Field label="Password" hint={PASSWORD_HINT} error={errorFor('password')}>
                  <TextInput
                    type="password"
                    required
                    minLength={10}
                    value={editor.password}
                    onChange={(e) => setEditor({ ...editor, password: e.target.value })}
                    onBlur={blurHandler('password')}
                  />
                </Field>
              )}
              {editor.mode !== 'edit' && needsReauth && (
                <Field
                  label="Your current password"
                  hint="Creating an account is a credential-level action, so it is confirmed."
                >
                  <TextInput
                    aria-label="Your current password"
                    type="password"
                    autoComplete="current-password"
                    value={editor.current_password}
                    onChange={(e) => setEditor({ ...editor, current_password: e.target.value })}
                  />
                </Field>
              )}
              {editor.mode !== 'invite' && (
                <>
                  <Field label="First name">
                    <TextInput
                      value={editor.first_name}
                      onChange={(e) => setEditor({ ...editor, first_name: e.target.value })}
                    />
                  </Field>
                  <Field label="Last name">
                    <TextInput
                      value={editor.last_name}
                      onChange={(e) => setEditor({ ...editor, last_name: e.target.value })}
                    />
                  </Field>
                </>
              )}
              <Field label="Partner" hint="Scopes partner/member roles to this organisation.">
                <Select
                  value={editor.partner_id}
                  onChange={(e) => setEditor({ ...editor, partner_id: e.target.value })}
                  /*
                   * With no organisations listed the only reachable option is
                   * "No partner", and this select writes into the editor — so
                   * an outage turned it into a one-way detach for an account
                   * whose partner the admin was not editing.
                   */
                  disabled={partnersFailed}
                >
                  <option value="">No partner</option>
                  {/*
                   * A controlled select whose value matches no option selects
                   * nothing, so during the outage a user *with* an organisation
                   * displayed as one without — the same misreading the roles
                   * box makes. Carrying the id keeps the control honest about
                   * what will be saved.
                   */}
                  {editor.partner_id && !partners.some((p) => p.id === editor.partner_id) && (
                    <option value={editor.partner_id}>{editor.partner_id}</option>
                  )}
                  {partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <PickerOverflowNote truncated={partnersCapped} />
                </Select>
                {partnersFailed && (
                  <p className="mt-1 text-sm text-ink-400">
                    Organisations could not be listed, so this cannot be changed here. Saving now leaves it as
                    it is.
                  </p>
                )}
              </Field>
            </div>
            <fieldset aria-describedby={errorFor('roles') ? 'roles-error' : undefined}>
              <legend className="mb-2 block text-[0.8rem] font-semibold text-ink-700">Roles</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {roleDefs.map((r) => (
                  <label
                    key={r.key}
                    // The description is the whole point of serving the
                    // catalog: `data_supervisor` and `support_supervisor`
                    // differ by a word, and a bare key is not a choice.
                    title={`${r.description} (${SCOPE_LABELS[r.scope]})`}
                    className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-700"
                  >
                    <input
                      type="checkbox"
                      checked={editor.roles.has(r.key)}
                      onChange={() => toggleRole(r.key)}
                      className="accent-bond-600"
                    />
                    {r.label}
                  </label>
                ))}
              </div>
              {roleCatalogFailed && (
                /*
                 * Saying which roles the account keeps matters more here than
                 * anywhere else on the page. `editor.roles` is seeded from the
                 * user and submitted as-is, so a save during the outage is
                 * genuinely harmless — but a blank Roles box reads as "this
                 * account has none", and an admin who believes that will act on
                 * it. The restore path is the case that bites: it drops the
                 * admin into this editor on purpose, with roles reset to
                 * `valuation_user`, precisely so the account "doesn't come back
                 * scoped to nothing" — which is exactly what an unusable
                 * catalog leaves it as.
                 */
                <p className="mt-1 text-sm text-ink-400">
                  The role catalog could not be loaded, so roles cannot be shown or changed here. Saving now
                  leaves this account&rsquo;s roles exactly as they are. Reload the page to try again.
                </p>
              )}
              {errorFor('roles') && (
                <p id="roles-error" className="mt-2 text-xs font-medium text-red-600">
                  {errorFor('roles')}
                </p>
              )}
            </fieldset>
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={busy || (editor.mode !== 'edit' && needsReauth && !editor.current_password)}
              >
                {busy
                  ? 'Saving…'
                  : editor.mode === 'invite'
                    ? 'Send invitation'
                    : editor.mode === 'create'
                      ? 'Create user'
                      : 'Save changes'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditor(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </section>
      )}

      {/* Invitations (feature #9) */}
      {invitationsFailed && (
        <p className="mt-6 text-sm text-ink-400">
          Pending invitations could not be listed. Reload the page before sending another — someone may
          already have a live invitation.
        </p>
      )}
      {invitations.length > 0 && (
        <section className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
          <h2 className="overline border-b border-paper-300 px-5 py-3 text-ink-400">Invitations</h2>
          <table className="w-full min-w-[640px] text-sm" aria-label="Invitations">
            <thead>
              <tr className="sr-only">
                <th scope="col">Invitee</th>
                <th scope="col">Status</th>
                <th scope="col">Expires</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((i) => {
                const status = invitationStatus(i);
                const pending = status.label === 'Pending';
                return (
                  <tr key={i.id} className="border-b border-paper-200 last:border-0">
                    <td className="px-5 py-3">
                      <div className="font-semibold text-ink-900">{i.email}</div>
                      <div className="text-xs text-ink-400">
                        {i.roles.join(', ')}
                        {i.partner_name ? ` · ${i.partner_name}` : ''}
                        {i.invited_by_email ? ` · invited by ${i.invited_by_email}` : ''}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${status.tone}`}
                      >
                        {status.label}
                      </span>
                    </td>
                    <td className="tnum px-5 py-3 text-xs text-ink-400">
                      expires {formatDate(i.expires_at)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-3 text-xs font-semibold">
                        {(pending || status.label === 'Expired') && !i.accepted_at && !i.revoked_at && (
                          <button
                            onClick={() => resendInvite(i)}
                            className="cursor-pointer text-bond-600 hover:text-bond-700"
                          >
                            Resend
                          </button>
                        )}
                        {pending && (
                          <button
                            onClick={() => revokeInvite(i)}
                            className="cursor-pointer text-red-600 hover:text-red-700"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* The ledger keeps accepted and revoked invitations too, so this cap
              is reached by tenure rather than by backlog — and a pending
              invitation past it reads as an address nobody has invited, which
              is the same wrong answer the outage note above exists for. */}
          <div className="px-5 pb-4">
            <ListTruncationNote
              truncated={invitationsCapped}
              shown={invitations.length}
              noun="invitations"
              hint="the oldest are not listed"
            />
          </div>
        </section>
      )}

      {error && (
        <div className="mt-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {exportNote && (
        <div
          role="status"
          className="mt-6 rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800"
        >
          {exportNote}
        </div>
      )}
      {notice && <SuccessNote className="mt-6">{notice}</SuccessNote>}
      {!data && !error && (
        <div className="mt-6 rounded-lg border border-paper-300 bg-surface shadow-card">
          <TableSkeleton columns={5} rows={8} label="Loading users…" />
        </div>
      )}

      {data && data.users.length === 0 && (
        <div className="mt-6">
          <EmptyState title="No users match" />
        </div>
      )}

      {data && data.users.length > 0 && (
        <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">Users</caption>
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">User</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Roles</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Partner</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Joined</th>
                <th className="overline px-5 py-3 font-semibold text-ink-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr
                  key={u.id}
                  className={`border-b border-paper-200 last:border-0 ${u.deleted_at ? 'opacity-60' : ''}`}
                >
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-ink-900">
                      {displayName(u)}
                      {u.deleted_at && (
                        <span className="ml-2 rounded-full bg-paper-200 px-2 py-0.5 text-[0.65rem] font-semibold text-ink-500 ring-1 ring-ink-200 ring-inset">
                          Deactivated
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-ink-400">{u.email}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex flex-wrap gap-1">
                      {u.roles.map((r) => (
                        <span
                          key={r}
                          className="rounded border border-ink-200 bg-surface px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold text-ink-700"
                        >
                          {r}
                        </span>
                      ))}
                      {u.roles.length === 0 && <span className="text-xs text-ink-400">none</span>}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-ink-600">{u.partner_name ?? '—'}</td>
                  <td className="tnum px-5 py-3.5 text-ink-600">{formatDate(u.created_at)}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex gap-3 text-xs font-semibold">
                      {u.deleted_at ? (
                        <button
                          onClick={() => restore(u)}
                          className="cursor-pointer text-bond-600 hover:text-bond-700"
                        >
                          Restore
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => openEdit(u)}
                            className="cursor-pointer text-bond-600 hover:text-bond-700"
                          >
                            Edit
                          </button>
                          {/* Streamlined role promotion (feature A). */}
                          {!u.roles.includes('admin') && (
                            <button
                              onClick={() => promote(u)}
                              className="cursor-pointer text-bond-600 hover:text-bond-700"
                            >
                              Promote to admin
                            </button>
                          )}
                          {/* Self-demotion is blocked, so hide it on your own row. */}
                          {u.roles.includes('admin') && u.id !== user?.id && (
                            <button
                              onClick={() => demote(u)}
                              className="cursor-pointer text-red-600 hover:text-red-700"
                            >
                              Remove admin
                            </button>
                          )}
                          {!u.sso_provider && (
                            <button
                              onClick={() => sendPasswordReset(u)}
                              className="cursor-pointer text-bond-600 hover:text-bond-700"
                            >
                              Send reset
                            </button>
                          )}
                          {u.id !== user?.id && (
                            <>
                              <button
                                onClick={() => revokeSessions(u)}
                                className="cursor-pointer text-bond-600 hover:text-bond-700"
                              >
                                Sign out
                              </button>
                              <button
                                onClick={() => remove(u)}
                                className="cursor-pointer text-red-600 hover:text-red-700"
                              >
                                Deactivate
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > PER_PAGE && (
        <div className="mt-5 flex items-center justify-between text-sm text-ink-600">
          <span className="tnum">
            Page {data.page} of {totalPages} · {data.total} total
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={page <= 1}
              onClick={() =>
                setParams((p) => {
                  const next = new URLSearchParams(p);
                  next.set('page', String(page - 1));
                  return next;
                })
              }
            >
              ← Previous
            </Button>
            <Button
              variant="secondary"
              disabled={page >= totalPages}
              onClick={() =>
                setParams((p) => {
                  const next = new URLSearchParams(p);
                  next.set('page', String(page + 1));
                  return next;
                })
              }
            >
              Next →
            </Button>
          </div>
        </div>
      )}

      <RoleMatrix roles={roleDefs} capabilities={capabilities} />
    </div>
  );
}
