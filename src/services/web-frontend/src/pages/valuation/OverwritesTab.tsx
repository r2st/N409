import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, describeActionFailure } from '../../lib/api';
import {
  OVERWRITE_CATEGORY_LABELS,
  type Overwrite,
  type OverwriteFieldDef,
  type OverwriteSchema,
} from '../../lib/m2';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import {
  Button,
  ErrorNote,
  Field,
  LoadError,
  Spinner,
  TextInput,
  WriteGate,
  useRetry,
} from '../../components/ui';

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return value.toLocaleString();
  return String(value);
}

function OverrideForm({
  def,
  existing,
  onSave,
  onCancel,
  busy,
}: {
  def: OverwriteFieldDef;
  existing: Overwrite | null;
  onSave: (value: string | number, reason: string, originalValue: string | number | null) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [value, setValue] = useState(existing ? String(existing.value) : '');
  const [reason, setReason] = useState(existing?.reason ?? '');
  const [original, setOriginal] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = () => {
    setLocalError(null);
    let parsed: string | number = value;
    if (def.class === 'numeric') {
      parsed = Number(value);
      if (value.trim() === '' || !Number.isFinite(parsed)) {
        setLocalError('Enter a number.');
        return;
      }
    } else if (value.trim() === '') {
      setLocalError('Enter a value.');
      return;
    }
    let parsedOriginal: string | number | null = null;
    if (!existing && original.trim() !== '') {
      parsedOriginal = def.class === 'numeric' ? Number(original) : original.trim();
      if (def.class === 'numeric' && !Number.isFinite(parsedOriginal as number)) {
        setLocalError('Original value must be a number.');
        return;
      }
    }
    onSave(parsed, reason.trim(), parsedOriginal);
  };

  return (
    <div className="space-y-4 rounded-md border border-bond-200 bg-bond-50/40 p-4">
      {localError && <ErrorNote>{localError}</ErrorNote>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={`Override value (${def.class})`}
          hint={
            def.class === 'date'
              ? 'YYYY-MM-DD'
              : def.min !== undefined || def.max !== undefined
                ? `Range: ${def.min ?? '−∞'} to ${def.max ?? '∞'}`
                : `e.g. ${def.example}`
          }
        >
          {def.class === 'date' ? (
            <TextInput type="date" value={value} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <TextInput
              value={value}
              inputMode={def.class === 'numeric' ? 'decimal' : undefined}
              onChange={(e) => setValue(e.target.value)}
              placeholder={String(def.example)}
            />
          )}
        </Field>
        {!existing && (
          <Field
            label="Original value (optional)"
            hint="The AI/computed value being replaced — kept for audit."
          >
            <TextInput value={original} onChange={(e) => setOriginal(e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="Reason" hint="Why the source value is being overridden.">
        <TextInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </Field>
      <div className="flex gap-2">
        <Button onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : existing ? 'Update override' : 'Apply override'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Manual overrides (features.md §3.6): every overridable field grouped by
 * category; overridden fields are highlighted with the original value and
 * reason preserved for audit.
 */
export function OverwritesTab() {
  const { valuation, retired } = useWorkspace();
  const [schema, setSchema] = useState<OverwriteSchema | null>(null);
  const [overwrites, setOverwrites] = useState<Overwrite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [schemaRes, listRes] = await Promise.all([
        api<OverwriteSchema>('/overwrites/schema'),
        api<{ overwrites: Overwrite[] }>(`/valuations/${valuation.id}/overwrites`),
      ]);
      setSchema(schemaRes);
      setOverwrites(listRes.overwrites);
    } catch (err) {
      setError(describeActionFailure(err, 'Could not load overwrites.'));
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load, token]);

  const byKey = useMemo(() => new Map((overwrites ?? []).map((o) => [o.field_key, o])), [overwrites]);

  if (error && !schema) return <LoadError message={error} {...retryProps} />;
  if (!schema || !overwrites) return <Spinner />;

  const save = async (
    def: OverwriteFieldDef,
    value: string | number,
    reason: string,
    originalValue: string | number | null,
  ) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/valuations/${valuation.id}/overwrites/${def.key}`, {
        method: 'PUT',
        body: {
          value,
          ...(reason ? { reason } : {}),
          ...(originalValue !== null ? { original_value: originalValue } : {}),
        },
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not save the override.'));
    } finally {
      setBusy(false);
    }
  };

  const revert = async (fieldKey: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/valuations/${valuation.id}/overwrites/${fieldKey}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not revert the override.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-400">
          Manual analyst overrides of AI-extracted and computed values. Originals are preserved for audit.
        </p>
        <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset">
          {overwrites.length} of {schema.total} overridden
        </span>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}

      {schema.categories.map((category) => {
        const fields = schema.fields.filter((f) => f.category === category.key);
        return (
          <section key={category.key} className="rounded-lg border border-paper-300 bg-surface shadow-card">
            <h2 className="flex items-baseline justify-between border-b border-paper-300 px-5 py-3.5">
              <span className="font-display text-base font-semibold text-ink-900">
                {OVERWRITE_CATEGORY_LABELS[category.key] ?? category.key}
              </span>
              <span className="text-xs text-ink-400">
                {fields.filter((f) => byKey.has(f.key)).length} / {fields.length} overridden
              </span>
            </h2>
            <ul className="divide-y divide-paper-200">
              {fields.map((def) => {
                const overwrite = byKey.get(def.key) ?? null;
                const isEditing = editing === def.key;
                return (
                  <li key={def.key} className={`px-5 py-3 ${overwrite ? 'bg-amber-50/50' : ''}`}>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-ink-800">{def.label}</span>
                          <code className="rounded bg-paper-200 px-1.5 py-0.5 text-[0.65rem] text-ink-500">
                            {def.key}
                          </code>
                          {overwrite && (
                            <span
                              className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.65rem] font-bold text-amber-800 uppercase"
                              title={`Original: ${formatValue(overwrite.original_value)}${overwrite.reason ? ` · Reason: ${overwrite.reason}` : ''}`}
                            >
                              overridden
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-ink-400" title={def.description}>
                          {def.description}
                        </p>
                      </div>
                      <div className="tnum text-right text-sm">
                        {overwrite ? (
                          <>
                            <div className="font-semibold text-amber-900">{formatValue(overwrite.value)}</div>
                            <div className="text-xs text-ink-400 line-through">
                              {formatValue(overwrite.original_value)}
                            </div>
                          </>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </div>
                      <WriteGate closed={retired}>
                        <div className="flex gap-2">
                          <Button
                            variant="secondary"
                            className="!px-2.5 !py-1 !text-xs"
                            onClick={() => setEditing(isEditing ? null : def.key)}
                            disabled={busy}
                          >
                            {overwrite ? 'Edit' : 'Override'}
                          </Button>
                          {overwrite && (
                            <Button
                              variant="danger"
                              className="!px-2.5 !py-1 !text-xs"
                              onClick={() => void revert(def.key)}
                              disabled={busy}
                            >
                              Revert
                            </Button>
                          )}
                        </div>
                      </WriteGate>
                    </div>
                    {overwrite && (overwrite.reason || overwrite.updated_at) && !isEditing && (
                      <p className="mt-1.5 text-xs text-ink-400">
                        {overwrite.reason && <span className="italic">“{overwrite.reason}” · </span>}
                        {formatDateTime(overwrite.updated_at)}
                      </p>
                    )}
                    {isEditing && (
                      <div className="mt-3">
                        <OverrideForm
                          def={def}
                          existing={overwrite}
                          busy={busy}
                          onCancel={() => setEditing(null)}
                          onSave={(value, reason, originalValue) =>
                            void save(def, value, reason, originalValue)
                          }
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
