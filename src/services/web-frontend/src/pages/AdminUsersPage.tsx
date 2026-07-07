import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { api, apiDownload, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { canManageUsers } from '../lib/rbac';
import { displayName, formatDate } from '../lib/format';
import type { AdminUser, Partner } from '../lib/types';
import { Button, EmptyState, ErrorNote, Field, Select, Spinner, TextInput } from '../components/ui';

const PER_PAGE = 25;

/** Role keys mirrored from the valuation service (domain/roles.ts). */
const ROLE_KEYS = [
  'valuation_user',
  'admin',
  'god',
  'supervisor',
  'support',
  'support_supervisor',
  'reviewer',
  'main_reviewer',
  'contributing_reviewer',
  'data',
  'data_supervisor',
  'partner',
  'member',
  'investor',
  'auto',
  'spa',
  'ignored',
] as const;

interface UserList {
  users: AdminUser[];
  page: number;
  per_page: number;
  total: number;
}

interface EditorState {
  mode: 'create' | 'edit';
  id?: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  partner_id: string;
  roles: Set<string>;
}

const emptyEditor = (): EditorState => ({
  mode: 'create',
  email: '',
  password: '',
  first_name: '',
  last_name: '',
  partner_id: '',
  roles: new Set(['valuation_user']),
});

/** M3 feature 13 — user/role admin console. */
export function AdminUsersPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<UserList | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qDraft, setQDraft] = useState(params.get('q') ?? '');

  const q = params.get('q') ?? '';
  const role = params.get('role') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const load = useCallback(() => {
    setError(null);
    const query = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
    if (q) query.set('q', q);
    if (role) query.set('role', role);
    api<UserList>(`/users?${query}`)
      .then(setData)
      .catch(() => setError('Could not load users.'));
  }, [q, role, page]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<{ partners: Partner[] }>('/partners')
      .then((res) => setPartners(res.partners))
      .catch(() => {});
  }, []);

  // The API enforces this too — the redirect just keeps the nav honest.
  if (!canManageUsers(user)) return <Navigate to="/dashboard" replace />;

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
    });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editor) return;
    setBusy(true);
    setEditorError(null);
    try {
      if (editor.mode === 'create') {
        await api('/users', {
          method: 'POST',
          body: {
            email: editor.email.trim(),
            password: editor.password,
            first_name: editor.first_name.trim() || undefined,
            last_name: editor.last_name.trim() || undefined,
            partner_id: editor.partner_id || null,
            roles: [...editor.roles],
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
      setEditorError(err instanceof ApiError ? err.message : 'Could not save the user.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u: AdminUser) => {
    if (!window.confirm(`Deactivate ${u.email}? They will no longer be able to sign in.`)) return;
    try {
      await api(`/users/${u.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the user.');
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
              void apiDownload(`/users/export?${query}`, 'users.csv').catch(() =>
                setError('Could not export CSV.'),
              );
            }}
          >
            ↓ Export CSV
          </Button>
          <Button
            onClick={() => {
              setEditorError(null);
              setEditor(emptyEditor());
            }}
          >
            + New user
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
        </div>
        <Select
          aria-label="Filter by role"
          value={role}
          onChange={(e) => setFilter('role', e.target.value)}
          className="!w-auto min-w-36"
        >
          <option value="">All roles</option>
          {ROLE_KEYS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <button type="submit" hidden />
      </form>

      {/* Create / edit panel */}
      {editor && (
        <section className="mt-6 rounded-lg border border-paper-300 bg-white p-6 shadow-card">
          <h2 className="overline mb-5 text-ink-400">
            {editor.mode === 'create' ? 'New user' : `Edit ${editor.email}`}
          </h2>
          <form onSubmit={save} className="space-y-5">
            {editorError && <ErrorNote>{editorError}</ErrorNote>}
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Email">
                <TextInput
                  type="email"
                  required
                  value={editor.email}
                  onChange={(e) => setEditor({ ...editor, email: e.target.value })}
                />
              </Field>
              {editor.mode === 'create' && (
                <Field label="Password" hint="At least 10 characters.">
                  <TextInput
                    type="password"
                    required
                    minLength={10}
                    value={editor.password}
                    onChange={(e) => setEditor({ ...editor, password: e.target.value })}
                  />
                </Field>
              )}
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
              <Field label="Partner" hint="Scopes partner/member roles to this organisation.">
                <Select
                  value={editor.partner_id}
                  onChange={(e) => setEditor({ ...editor, partner_id: e.target.value })}
                >
                  <option value="">No partner</option>
                  {partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <fieldset>
              <legend className="mb-2 block text-[0.8rem] font-semibold text-ink-700">Roles</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {ROLE_KEYS.map((r) => (
                  <label key={r} className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-700">
                    <input
                      type="checkbox"
                      checked={editor.roles.has(r)}
                      onChange={() => toggleRole(r)}
                      className="accent-bond-600"
                    />
                    {r}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || editor.roles.size === 0}>
                {busy ? 'Saving…' : editor.mode === 'create' ? 'Create user' : 'Save changes'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditor(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </section>
      )}

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {!data && !error && <Spinner />}

      {data && data.users.length === 0 && (
        <div className="mt-6">
          <EmptyState title="No users match" />
        </div>
      )}

      {data && data.users.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
          <table className="w-full min-w-[720px] text-sm">
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
                <tr key={u.id} className="border-b border-paper-200 last:border-0">
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-ink-900">{displayName(u)}</div>
                    <div className="text-xs text-ink-400">{u.email}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex flex-wrap gap-1">
                      {u.roles.map((r) => (
                        <span
                          key={r}
                          className="rounded border border-ink-200 bg-white px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold text-ink-700"
                        >
                          {r}
                        </span>
                      ))}
                      {u.roles.length === 0 && <span className="text-xs text-ink-300">none</span>}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-ink-600">{u.partner_name ?? '—'}</td>
                  <td className="tnum px-5 py-3.5 text-ink-600">{formatDate(u.created_at)}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex gap-3 text-xs font-semibold">
                      <button
                        onClick={() => openEdit(u)}
                        className="cursor-pointer text-bond-600 hover:text-bond-700"
                      >
                        Edit
                      </button>
                      {u.id !== user?.id && (
                        <button
                          onClick={() => remove(u)}
                          className="cursor-pointer text-red-600 hover:text-red-700"
                        >
                          Deactivate
                        </button>
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
              onClick={() => setParams((p) => {
                const next = new URLSearchParams(p);
                next.set('page', String(page - 1));
                return next;
              })}
            >
              ← Previous
            </Button>
            <Button
              variant="secondary"
              disabled={page >= totalPages}
              onClick={() => setParams((p) => {
                const next = new URLSearchParams(p);
                next.set('page', String(page + 1));
                return next;
              })}
            >
              Next →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
