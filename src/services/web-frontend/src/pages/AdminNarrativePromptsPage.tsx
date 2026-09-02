import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, describeActionFailure, describeLoadFailure } from '../lib/api';
import { diffLines } from '../lib/diff';
import { formatDateTime, KIND_LABELS } from '../lib/format';
import type { ValuationKind } from '../lib/types';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  inputClass,
  LoadError,
  Select,
  Spinner,
  TextInput,
  useRetry,
} from '../components/ui';

/**
 * The narrative prompt library editor (design §6.3).
 *
 * Migration 0114 moved the report's per-section guidance out of a Python tuple
 * and into rows, with `default_guidance` preserved, so a reviewer could change
 * how the DLOM discussion is framed and how the conclusion is worded without a
 * deploy. Five endpoints and the whole chain into the drafting agent have been
 * live since; without this page a reviewer still needed an engineer with a
 * bearer token, and the migration's own rationale went unfulfilled for want of
 * one component.
 *
 * The resolution model is two layers and only two: `kind IS NULL` is the base
 * library, and a kind's row with the same `section_key` *replaces* it. That is
 * what the page has to make legible, because base-plus-override is exactly what
 * an editor gets wrong unaided — which is why the preview panel is here and not
 * an afterthought.
 */

interface NarrativePrompt {
  id: string;
  kind: ValuationKind | null;
  section_key: string;
  label: string;
  guidance: string;
  sort_order: number;
  enabled: boolean;
  default_guidance: string;
  updated_at: string;
}

interface ResolvedSection {
  key: string;
  label: string;
  guidance: string;
  overridden: boolean;
}

const BASE = '__base__';

/** Unified diff of a row's guidance against the text it shipped as. */
function GuidanceDiff({ from, to }: { from: string; to: string }) {
  const lines = diffLines(from, to);
  if (lines.every((l) => l.kind === 'same')) {
    return <p className="px-3 py-2 text-xs text-ink-400">Unchanged from the seeded text.</p>;
  }
  return (
    <pre className="max-h-64 overflow-auto overscroll-contain rounded-md border border-paper-300 bg-paper-50 p-3 text-xs leading-relaxed">
      {lines.map((l, idx) => (
        <div
          key={idx}
          className={
            l.kind === 'added'
              ? 'bg-bond-50 text-bond-700'
              : l.kind === 'removed'
                ? 'bg-red-50 text-red-700 line-through decoration-red-300'
                : 'text-ink-600'
          }
        >
          {l.kind === 'added' ? '+ ' : l.kind === 'removed' ? '− ' : '  '}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

function SectionCard({
  prompt,
  scope,
  onChanged,
  onDirtyChange,
}: {
  prompt: NarrativePrompt;
  /** How this row relates to the kind on screen. */
  scope: 'base' | 'override';
  onChanged: () => Promise<void>;
  onDirtyChange: (id: string, dirty: boolean) => void;
}) {
  const [label, setLabel] = useState(prompt.label);
  const [guidance, setGuidance] = useState(prompt.guidance);
  const [sortOrder, setSortOrder] = useState(String(prompt.sort_order));
  const [enabled, setEnabled] = useState(prompt.enabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    label !== prompt.label ||
    guidance !== prompt.guidance ||
    sortOrder !== String(prompt.sort_order) ||
    enabled !== prompt.enabled;

  useEffect(() => {
    onDirtyChange(prompt.id, dirty);
  }, [dirty, prompt.id, onDirtyChange]);

  const edited = prompt.guidance !== prompt.default_guidance;

  const save = async () => {
    const order = Number(sortOrder);
    if (!Number.isInteger(order) || order < 0 || order > 10_000) {
      setError('Sort order must be a whole number between 0 and 10000.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/admin/narrative-prompts/${prompt.id}`, {
        method: 'PATCH',
        body: { label, guidance, sort_order: order, enabled },
      });
      await onChanged();
      setSaved(true);
    } catch (err) {
      setError(describeActionFailure(err, 'Could not save the section.'));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm(`Reset “${prompt.label}” to the text it shipped with?`)) return;
    setSaving(true);
    setError(null);
    try {
      const { prompt: row } = await api<{ prompt: NarrativePrompt }>(
        `/admin/narrative-prompts/${prompt.id}/reset`,
        { method: 'POST' },
      );
      setGuidance(row.guidance);
      setEnabled(row.enabled);
      await onChanged();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not reset the section.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-display text-base font-semibold text-ink-900">{prompt.label}</h2>
        <span className="font-mono text-xs text-ink-400">{prompt.section_key}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[0.65rem] font-semibold ring-1 ring-inset ${
            scope === 'override'
              ? 'bg-bond-50 text-bond-700 ring-bond-200'
              : 'bg-paper-100 text-ink-500 ring-paper-300'
          }`}
        >
          {scope === 'override' ? 'override' : 'base'}
        </span>
        {edited && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[0.65rem] font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset">
            edited
          </span>
        )}
        {!prompt.enabled && (
          <span className="rounded-full bg-paper-200 px-2 py-0.5 text-[0.65rem] font-semibold text-ink-500">
            off
          </span>
        )}
        <span className="tnum ml-auto text-xs text-ink-400">Updated {formatDateTime(prompt.updated_at)}</span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Field label="Heading">
            <TextInput value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
          </Field>
        </div>
        <Field label="Sort order" hint="Sparse — leave gaps so a section can be inserted between two.">
          <TextInput value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <div className="mt-4">
        <Field
          label="Guidance"
          hint="What this section must cover, in the words handed to the model. Not the prose itself."
        >
          <textarea
            className={`${inputClass} min-h-28 text-sm leading-relaxed`}
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            maxLength={8000}
          />
        </Field>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Draft this section
        {scope === 'override' && (
          <span className="text-xs text-ink-400">
            — turning an override off suppresses the base section too, which is what it means.
          </span>
        )}
      </label>

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={saving || !dirty || guidance.trim() === ''}>
          {saving ? 'Saving…' : 'Save section'}
        </Button>
        {edited && (
          <Button variant="secondary" onClick={() => void reset()} disabled={saving}>
            Reset to default
          </Button>
        )}
        {saved && !dirty && <span className="text-sm font-medium text-bond-700">Saved.</span>}
      </div>

      {edited && (
        <details className="mt-5 border-t border-paper-300 pt-4">
          <summary className="cursor-pointer text-sm font-semibold text-ink-700 select-none">
            What changed from the default
          </summary>
          <div className="mt-3">
            <GuidanceDiff from={prompt.default_guidance} to={prompt.guidance} />
          </div>
        </details>
      )}
    </section>
  );
}

/**
 * The assembled section list for the selected kind.
 *
 * The panel that earns its place: base-plus-override resolution is the thing an
 * editor gets wrong unaided, and "show me the sections a gift & estate report
 * will actually be drafted with" otherwise takes running a valuation to answer.
 */
function PreviewPanel({ kind }: { kind: ValuationKind }) {
  const [sections, setSections] = useState<ResolvedSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));

  useEffect(() => {
    setSections(null);
    setError(null);
    api<{ sections: ResolvedSection[] }>(`/admin/narrative-prompts/preview/${kind}`)
      .then((d) => setSections(d.sections))
      .catch((err: unknown) => setError(describeLoadFailure(err, 'Could not load the preview.')));
  }, [kind, token]);

  if (error) return <LoadError message={error} {...retryProps} />;
  if (!sections) return <Spinner />;

  return (
    <div className="rounded-lg border border-paper-300 bg-paper-50 p-5">
      <div className="overline mb-3 text-ink-400">
        A {KIND_LABELS[kind] ?? kind} report drafts these sections, in this order
      </div>
      {sections.length === 0 ? (
        <p className="text-sm text-ink-500">
          Nothing resolves for this kind — the agent falls back to its built-in 409A sections.
        </p>
      ) : (
        <ol className="space-y-2">
          {sections.map((s, i) => (
            <li key={s.key} className="flex items-start gap-3 text-sm">
              <span className="tnum mt-0.5 w-5 shrink-0 text-right text-xs text-ink-400">{i + 1}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold text-ink-800">{s.label}</span>
                  <span className="font-mono text-xs text-ink-400">{s.key}</span>
                  {s.overridden && (
                    <span className="rounded-full bg-bond-50 px-2 py-0.5 text-[0.65rem] font-semibold text-bond-700 ring-1 ring-bond-200 ring-inset">
                      override
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-ink-500">{s.guidance}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function AdminNarrativePromptsPage() {
  const [prompts, setPrompts] = useState<NarrativePrompt[] | null>(null);
  const [kinds, setKinds] = useState<ValuationKind[]>([]);
  const [selected, setSelected] = useState<string>(BASE);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const data = await api<{ prompts: NarrativePrompt[]; kinds: ValuationKind[] }>(
        '/admin/narrative-prompts',
      );
      setPrompts(data.prompts);
      setKinds(data.kinds);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'The narrative prompt library is operations-only.'
          : 'Could not load the narrative prompt library.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, token]);

  const onDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((prev) => {
      if (dirty === prev.has(id)) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /*
   * Unsaved guidance is the kind of edit someone spends ten minutes on and then
   * navigates away from. The browser guard is crude but it is the only one that
   * catches a closed tab.
   */
  useEffect(() => {
    if (dirtyIds.size === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirtyIds.size]);

  const switchKind = (next: string) => {
    if (
      dirtyIds.size > 0 &&
      !window.confirm('You have unsaved section edits. Switch report type and lose them?')
    ) {
      return;
    }
    setDirtyIds(new Set());
    setSelected(next);
  };

  if (error) return <LoadError message={error} {...retryProps} />;
  if (!prompts) return <Spinner />;

  const isBase = selected === BASE;
  const kind = isBase ? null : (selected as ValuationKind);
  const rows = prompts
    .filter((p) => (isBase ? p.kind === null : p.kind === kind))
    .sort((a, b) => a.sort_order - b.sort_order || a.section_key.localeCompare(b.section_key));

  // Which base sections this kind leaves alone — shown so an editor can see the
  // whole assembled list, not just the rows they can edit here.
  const inheritedCount = isBase
    ? 0
    : prompts.filter((p) => p.kind === null && !rows.some((r) => r.section_key === p.section_key)).length;

  return (
    <div>
      <h1 className="font-display text-3xl font-semibold text-ink-900">Narrative prompt library</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-500">
        What each report section must cover, per report type. The base library applies to any deliverable; a
        report type’s row with the same key replaces it. Changes apply to the next drafted narrative — no
        deploy needed.
      </p>

      <div className="mt-6 flex flex-wrap items-end gap-4">
        <Field label="Report type">
          <Select value={selected} onChange={(e) => switchKind(e.target.value)}>
            <option value={BASE}>Base library (all report types)</option>
            {kinds.map((k) => {
              const overrides = prompts.filter((p) => p.kind === k).length;
              return (
                <option key={k} value={k}>
                  {KIND_LABELS[k] ?? k}
                  {overrides > 0
                    ? ` — ${overrides} override${overrides === 1 ? '' : 's'}`
                    : ' — no overrides'}
                </option>
              );
            })}
          </Select>
        </Field>
        {dirtyIds.size > 0 && (
          <span className="pb-2 text-sm font-medium text-amber-700">
            {dirtyIds.size} unsaved section{dirtyIds.size === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {!isBase && kind && (
        <div className="mt-6">
          <PreviewPanel key={`${kind}:${prompts.map((p) => p.updated_at).join('')}`} kind={kind} />
        </div>
      )}

      <div className="mt-8 space-y-6">
        {rows.length === 0 ? (
          <EmptyState title="No overrides for this report type">
            This deliverable is drafted entirely from the base library
            {inheritedCount > 0 ? ` — all ${inheritedCount} sections` : ''}. Add an override by editing the
            base section and saving it under this kind, or leave it as is: a report type with nothing to say
            differently should say the same thing.
          </EmptyState>
        ) : (
          rows.map((p) => (
            <SectionCard
              key={p.id}
              prompt={p}
              scope={isBase ? 'base' : 'override'}
              onChanged={load}
              onDirtyChange={onDirtyChange}
            />
          ))
        )}
      </div>

      {!isBase && inheritedCount > 0 && (
        <p className="mt-6 text-sm text-ink-400">
          Plus {inheritedCount} section{inheritedCount === 1 ? '' : 's'} inherited unchanged from the base
          library. Switch to the base library to edit them for every report type.
        </p>
      )}
    </div>
  );
}
