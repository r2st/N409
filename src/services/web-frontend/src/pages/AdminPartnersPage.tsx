import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDate } from '../lib/format';
import type { Partner } from '../lib/types';
import { Button, EmptyState, ErrorNote, Field, Spinner, TextInput } from '../components/ui';

/** Admin console for partner organisations (P0 #1; full management is P1 #7). */
export function AdminPartnersPage() {
  const [partners, setPartners] = useState<Partner[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { partners: items } = await api<{ partners: Partner[] }>('/partners');
      setPartners(items);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Partner management is admin-only.'
          : 'Could not load partners.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setFormError(null);
    try {
      await api('/partners', { method: 'POST', body: { name: name.trim(), key: key.trim() } });
      setName('');
      setKey('');
      setCreating(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not create the partner.');
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: string) => {
    setBusy(true);
    setFormError(null);
    try {
      await api(`/partners/${id}`, { method: 'PATCH', body: { name: renameDraft.trim() } });
      setRenamingId(null);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not rename the partner.');
    } finally {
      setBusy(false);
    }
  };

  if (error && !partners) return <ErrorNote>{error}</ErrorNote>;
  if (!partners) return <Spinner />;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Administration</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Partners</h1>
          <p className="mt-1 text-sm text-ink-400">
            Organisations that channel valuations through the platform. Assign users to a partner
            from the users console.
          </p>
        </div>
        <Button onClick={() => setCreating((v) => !v)}>{creating ? 'Cancel' : '+ New partner'}</Button>
      </div>

      {creating && (
        <form
          className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-paper-300 bg-white px-5 py-4 shadow-card"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Field label="Name">
            <TextInput
              aria-label="Partner name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="SeedLegals"
              required
            />
          </Field>
          <Field label="Key" hint="Lowercase identifier used by integrations; cannot be changed later.">
            <TextInput
              aria-label="Partner key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="seedlegals"
              pattern="[a-z0-9-]+"
              required
            />
          </Field>
          <Button type="submit" disabled={busy || !name.trim() || !key.trim()}>
            Create partner
          </Button>
        </form>
      )}

      {formError && (
        <div className="mt-4">
          <ErrorNote>{formError}</ErrorNote>
        </div>
      )}

      {partners.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No partners yet">
            Create a partner organisation to start channelling valuations through it.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
          <table className="w-full min-w-[640px] text-sm" aria-label="Partners">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-5 py-3 font-semibold text-ink-400">Partner</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Key</th>
                <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Users</th>
                <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Valuations</th>
                <th className="overline px-4 py-3 font-semibold text-ink-400">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {partners.map((p) => (
                <tr key={p.id} className="border-b border-paper-200 last:border-0">
                  <td className="px-5 py-3.5">
                    {renamingId === p.id ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void rename(p.id);
                        }}
                      >
                        <TextInput
                          aria-label={`Rename ${p.name}`}
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          className="!w-52"
                          autoFocus
                        />
                        <Button type="submit" disabled={busy || !renameDraft.trim()}>
                          Save
                        </Button>
                        <Button variant="ghost" type="button" onClick={() => setRenamingId(null)}>
                          Cancel
                        </Button>
                      </form>
                    ) : (
                      <span className="font-semibold text-ink-900">{p.name}</span>
                    )}
                  </td>
                  <td className="px-4 py-3.5 font-mono text-xs text-ink-500">{p.key}</td>
                  <td className="tnum px-4 py-3.5 text-right text-ink-600">{p.user_count}</td>
                  <td className="tnum px-4 py-3.5 text-right text-ink-600">
                    {p.valuation_count > 0 ? (
                      <Link
                        to={`/valuations?partner_id=${p.id}`}
                        className="font-semibold text-bond-600 hover:text-bond-700"
                      >
                        {p.valuation_count}
                      </Link>
                    ) : (
                      p.valuation_count
                    )}
                  </td>
                  <td className="tnum px-4 py-3.5 text-ink-600">{formatDate(p.created_at)}</td>
                  <td className="px-4 py-3.5 text-right">
                    {renamingId !== p.id && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setRenamingId(p.id);
                          setRenameDraft(p.name);
                        }}
                      >
                        Rename
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
