import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, describeActionFailure } from '../lib/api';
import { all, pattern, required, useFormValidation } from '../lib/useFormValidation';
import { HelpIcon } from '../components/HelpIcon';
import { formatDateTime, KIND_LABELS } from '../lib/format';
import { VALUATION_KINDS } from '../lib/types';
import type { ReportTemplate } from '../lib/types';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  ListTruncationNote,
  LoadError,
  Select,
  Spinner,
  TextInput,
  useRetry,
} from '../components/ui';

/** Report template management (M4) — versioned templates like 409a.v54. Ops only. */

function StatusPill({ status }: { status: ReportTemplate['status'] }) {
  const styles = {
    draft: 'bg-amber-50 text-amber-800 ring-amber-200',
    active: 'bg-bond-50 text-bond-700 ring-bond-200',
    archived: 'bg-paper-200 text-ink-500 ring-ink-200',
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${styles[status]}`}
    >
      {status}
    </span>
  );
}

export function TemplatesPage() {
  const [templates, setTemplates] = useState<ReportTemplate[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', kind: '409a', body: '' });
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ templates: ReportTemplate[]; truncated: boolean }>('/report-templates');
      setTemplates(data.templates);
      // The page groups versions under `names`, which is derived from this
      // list: past the cap a whole template name disappears rather than one of
      // its versions, and the screen reads as though it was never created.
      setTruncated(data.truncated);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Report templates are operations-only.'
          : 'Could not load templates.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, token]);

  /*
   * Named by the caller: this wrapper carries four operations on a table of
   * many rows, and "Action failed." says which of them about as well as it says
   * which row. Activating is the one that costs most to leave unsaid — it is
   * what decides the skeleton every 409A rendered from here uses next.
   */
  const run = async (operation: string, fn: () => Promise<unknown>) => {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setActionError(describeActionFailure(err, operation));
    } finally {
      setBusy(false);
    }
  };

  /*
   * The name is the identity a version is minted under — "409a" is what makes
   * the next draft `409a.v55` rather than a second family — and the route
   * rejects anything outside the slug shape. The box carried `pattern`, which
   * the browser stopped enforcing the moment the form was told not to check.
   */
  const { errorFor, blurHandler, handleSubmit, reset } = useFormValidation(form, {
    name: all(
      required('name', 'Template name'),
      pattern(
        'name',
        /[a-z0-9][a-z0-9_-]*/,
        'Use lower-case letters, digits, hyphens and underscores, starting with a letter or digit.',
      ),
    ),
  });

  const create = handleSubmit(() => {
    void run('Could not create the template.', async () => {
      await api('/report-templates', {
        method: 'POST',
        body: { name: form.name.trim(), kind: form.kind, body: form.body },
      });
      setCreating(false);
      setForm({ name: '', kind: '409a', body: '' });
      reset();
    });
  });

  if (error) return <LoadError message={error} {...retryProps} />;
  if (!templates) return <Spinner />;

  const names = [...new Set(templates.map((t) => t.name))];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline flex items-center gap-1.5 text-ink-400">
            Operations
            <HelpIcon article="report-overview" />
          </div>
          <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Report templates</h1>
        </div>
        <Button onClick={() => setCreating((v) => !v)}>{creating ? 'Cancel' : '+ New version'}</Button>
      </div>

      {actionError && (
        <div className="mt-4">
          <ErrorNote>{actionError}</ErrorNote>
        </div>
      )}

      {creating && (
        <form
          onSubmit={create}
          className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
          noValidate
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Template name"
              hint="Reusing a name mints its next version (e.g. 409a → 409a.v2)."
              error={errorFor('name')}
            >
              <TextInput
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                onBlur={blurHandler('name')}
                required
                pattern="[a-z0-9][a-z0-9_-]*"
                placeholder="409a"
                list="template-names"
              />
              <datalist id="template-names">
                {names.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </Field>
            <Field label="Valuation kind">
              <Select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
                {VALUATION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mt-5">
            <Field label="Template body" hint="Markdown/HTML source consumed by the report service.">
              <textarea
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                rows={8}
                className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none"
              />
            </Field>
          </div>
          <Button type="submit" disabled={busy} className="mt-5">
            {busy ? 'Creating…' : 'Create draft'}
          </Button>
        </form>
      )}

      {templates.length === 0 && !creating && (
        <div className="mt-6">
          <EmptyState title="No templates yet">Create the first version to get started.</EmptyState>
        </div>
      )}

      {names.map((name) => (
        <section key={name} className="mt-8">
          <h2 className="overline mb-3 text-ink-400">{name}</h2>
          <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="sr-only">{`${name} versions`}</caption>
              <thead>
                <tr className="sr-only">
                  <th scope="col">Version</th>
                  <th scope="col">Status</th>
                  <th scope="col">Valuation type</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {templates
                  .filter((t) => t.name === name)
                  .map((t) => (
                    <tr key={t.id} className="border-b border-paper-200 align-top last:border-0">
                      <td className="px-5 py-3.5 font-mono text-xs font-semibold text-ink-900">{t.label}</td>
                      <td className="px-5 py-3.5">
                        <StatusPill status={t.status} />
                      </td>
                      <td className="px-5 py-3.5 text-ink-600">{KIND_LABELS[t.kind]}</td>
                      <td className="tnum px-5 py-3.5 text-xs text-ink-400">
                        {formatDateTime(t.updated_at)}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex justify-end gap-2">
                          {t.status === 'draft' && (
                            <>
                              <Button
                                variant="secondary"
                                disabled={busy}
                                onClick={() =>
                                  setEditing(editing?.id === t.id ? null : { id: t.id, body: t.body })
                                }
                              >
                                {editing?.id === t.id ? 'Close' : 'Edit'}
                              </Button>
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  void run('Could not activate that template version.', () =>
                                    api(`/report-templates/${t.id}/activate`, { method: 'POST' }),
                                  )
                                }
                              >
                                Activate
                              </Button>
                            </>
                          )}
                          {t.status !== 'archived' && (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                void run('Could not archive that template.', () =>
                                  api(`/report-templates/${t.id}/archive`, { method: 'POST' }),
                                )
                              }
                            >
                              Archive
                            </Button>
                          )}
                        </div>
                        {editing?.id === t.id && (
                          <div className="mt-3">
                            <textarea
                              aria-label={`Body of the ${t.name} template`}
                              value={editing.body}
                              onChange={(e) => setEditing({ id: t.id, body: e.target.value })}
                              rows={10}
                              className="w-full min-w-96 rounded-md border border-ink-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900 focus:border-bond-600 focus:outline-none"
                            />
                            <Button
                              disabled={busy}
                              className="mt-2"
                              onClick={() =>
                                void run('Could not save the template draft.', async () => {
                                  await api(`/report-templates/${t.id}`, {
                                    method: 'PATCH',
                                    body: { body: editing.body },
                                  });
                                  setEditing(null);
                                })
                              }
                            >
                              Save draft
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <ListTruncationNote truncated={truncated} shown={templates.length} noun="template versions" />
    </div>
  );
}
