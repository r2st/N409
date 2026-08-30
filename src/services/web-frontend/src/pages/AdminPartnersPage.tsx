import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, describeActionFailure } from '../lib/api';
import { all, pattern, required, useFormValidation } from '../lib/useFormValidation';
import { formatDate } from '../lib/format';
import type { Partner } from '../lib/types';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  LoadError,
  Spinner,
  TextInput,
  useRetry,
} from '../components/ui';

/** Admin console for partner organisations (P0 #1 + full management P1 #7). */
export function AdminPartnersPage() {
  const [partners, setPartners] = useState<Partner[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [formError, setFormError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', key: '' });
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { partners: items } = await api<{ partners: Partner[] }>('/partners?include_archived=true');
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
  }, [load, token]);

  /*
   * The key cannot be changed later, so a typo here is permanent — which is
   * why the shape the box declares is worth saying at the box rather than
   * leaving to the browser and then to a 422.
   */
  const { errorFor, blurHandler, handleSubmit, reset } = useFormValidation(draft, {
    name: required('name', 'Name'),
    key: all(
      required('key', 'Key'),
      pattern('key', /[a-z0-9-]+/, 'Key must be lowercase letters, digits and dashes only.'),
    ),
  });

  const create = handleSubmit(async () => {
    setBusy(true);
    setFormError(null);
    try {
      await api('/partners', {
        method: 'POST',
        body: { name: draft.name.trim(), key: draft.key.trim() },
      });
      setDraft({ name: '', key: '' });
      setCreating(false);
      reset();
      await load();
    } catch (err) {
      setFormError(describeActionFailure(err, 'Could not create the partner.'));
    } finally {
      setBusy(false);
    }
  });

  const patch = async (id: string, body: Record<string, unknown>, failure: string) => {
    setBusy(true);
    setFormError(null);
    try {
      await api(`/partners/${id}`, { method: 'PATCH', body });
      setRenamingId(null);
      await load();
    } catch (err) {
      setFormError(describeActionFailure(err, failure));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (p: Partner) => {
    if (
      !window.confirm(
        `Archive ${p.name}? It disappears from pickers and filters; existing users and valuations keep working.`,
      )
    )
      return;
    await patch(p.id, { archived: true }, 'Could not archive the partner.');
  };

  if (error && !partners) return <LoadError message={error} {...retryProps} />;
  if (!partners) return <Spinner />;

  const visible = showArchived ? partners : partners.filter((p) => !p.archived_at);
  const archivedCount = partners.filter((p) => p.archived_at).length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Administration</div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Partners</h1>
          <p className="mt-1 text-sm text-ink-400">
            Organisations that channel valuations through the platform. Assign users to a partner from the
            users console.
          </p>
          {/* Tokens are managed per firm below, but "who holds credentials"
              is a platform question and answering it firm by firm is not an
              answer — the cross-partner listing is one click from here. */}
          <Link
            to="/admin/api-tokens"
            className="mt-2 inline-block text-sm font-semibold text-bond-600 hover:text-bond-700"
          >
            API tokens across all partners &rarr;
          </Link>
        </div>
        <Button onClick={() => setCreating((v) => !v)}>{creating ? 'Cancel' : '+ New partner'}</Button>
      </div>

      {creating && (
        <form
          className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-paper-300 bg-surface px-5 py-4 shadow-card"
          onSubmit={create}
          noValidate
        >
          <Field label="Name" error={errorFor('name')}>
            <TextInput
              aria-label="Partner name"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              onBlur={blurHandler('name')}
              placeholder="SeedLegals"
              required
            />
          </Field>
          <Field
            label="Key"
            hint="Lowercase identifier used by integrations; cannot be changed later."
            error={errorFor('key')}
          >
            <TextInput
              aria-label="Partner key"
              value={draft.key}
              onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
              onBlur={blurHandler('key')}
              placeholder="seedlegals"
              pattern="[a-z0-9-]+"
              required
            />
          </Field>
          <Button type="submit" disabled={busy}>
            Create partner
          </Button>
        </form>
      )}

      {formError && (
        <div className="mt-4">
          <ErrorNote>{formError}</ErrorNote>
        </div>
      )}

      {archivedCount > 0 && (
        <label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-sm text-ink-600">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="accent-bond-600"
          />
          Show archived ({archivedCount})
        </label>
      )}

      {visible.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No partners yet">
            Create a partner organisation to start channelling valuations through it.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
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
              {visible.map((p) => (
                <tr
                  key={p.id}
                  className={`border-b border-paper-200 last:border-0 ${p.archived_at ? 'opacity-60' : ''}`}
                >
                  <td className="px-5 py-3.5">
                    {renamingId === p.id ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void patch(p.id, { name: renameDraft.trim() }, 'Could not rename the partner.');
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
                      <span className="flex items-center gap-2">
                        <Link
                          to={`/admin/partners/${p.id}`}
                          className="font-semibold text-ink-900 hover:text-bond-700"
                        >
                          {p.name}
                        </Link>
                        {p.archived_at && (
                          <span className="rounded-full bg-paper-200 px-2 py-0.5 text-xs font-semibold text-ink-500 ring-1 ring-inset ring-ink-200">
                            Archived
                          </span>
                        )}
                      </span>
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
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setRenamingId(p.id);
                            setRenameDraft(p.name);
                          }}
                        >
                          Rename
                        </Button>
                        {p.archived_at ? (
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void patch(p.id, { archived: false }, 'Could not restore the partner.')
                            }
                          >
                            Restore
                          </Button>
                        ) : (
                          <Button variant="ghost" disabled={busy} onClick={() => void archive(p)}>
                            Archive
                          </Button>
                        )}
                      </div>
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
