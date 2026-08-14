import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { diffLines } from '../lib/diff';
import { formatDateTime } from '../lib/format';
import { Button, EmptyState, ErrorNote, Field, Spinner, TextInput, inputClass } from '../components/ui';

export interface BotPrompt {
  id: string;
  pipeline: string;
  label: string;
  description: string | null;
  system_prompt: string;
  model: string | null;
  updated_at: string;
}

export interface PromptVersion {
  id: string;
  prompt_id: string;
  version: number;
  system_prompt: string;
  model: string | null;
  created_by_email: string | null;
  created_at: string;
}

export interface AiTestResult {
  model: string;
  content: string;
  anonymization?: { applied: boolean; redacted: Record<string, number>; enforced?: boolean };
}

const REDACTION_LABELS: Record<string, [string, string]> = {
  emails: ['email address', 'email addresses'],
  phones: ['phone number', 'phone numbers'],
  ssns: ['SSN', 'SSNs'],
  eins: ['EIN', 'EINs'],
  addresses: ['address', 'addresses'],
  names: ['name', 'names'],
  companies: ['company name', 'company names'],
};

/**
 * "2 email addresses and a phone number", or null when nothing was struck.
 *
 * Spelled out rather than shown as a count, because this is the one place the
 * number has to change a decision: someone iterating on prompt wording is
 * reading the model's answer to text they only think they sent, and "3" does
 * not tell them which of their sample's details never arrived.
 */
export function describeRedactions(redacted: Record<string, number> | undefined): string | null {
  const parts = Object.entries(redacted ?? {})
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => {
      const [one, many] = REDACTION_LABELS[kind] ?? [kind, kind];
      return n === 1 ? `1 ${one}` : `${n} ${many}`;
    });
  const last = parts.pop();
  if (last === undefined) return null;
  return parts.length === 0 ? last : `${parts.join(', ')} and ${last}`;
}

/** Unified line diff of a version's system prompt against the live content. */
function VersionDiff({ from, to }: { from: string; to: string }) {
  const lines = diffLines(from, to);
  if (lines.every((l) => l.kind === 'same')) {
    return <p className="px-3 py-2 text-xs text-ink-400">Identical to the current content.</p>;
  }
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-paper-300 bg-paper-50 p-3 text-xs leading-relaxed">
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

/** Version history (P1 #8): who changed what, diff vs current, revert. */
function VersionHistory({
  prompt,
  onReverted,
}: {
  prompt: BotPrompt;
  onReverted: (reverted: BotPrompt) => Promise<void> | void;
}) {
  const [versions, setVersions] = useState<PromptVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const [reverting, setReverting] = useState(false);

  const load = useCallback(async () => {
    try {
      const { versions: items } = await api<{ versions: PromptVersion[] }>(
        `/admin/prompts/${prompt.id}/versions`,
      );
      setVersions(items);
    } catch {
      setError('Could not load the version history.');
    }
  }, [prompt.id]);

  const revert = async (v: PromptVersion) => {
    if (!window.confirm(`Restore version ${v.version}? This is recorded as a new version.`)) return;
    setReverting(true);
    setError(null);
    try {
      const { prompt: reverted } = await api<{ prompt: BotPrompt }>(`/admin/prompts/${prompt.id}/revert`, {
        method: 'POST',
        body: { version: v.version },
      });
      await onReverted(reverted);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revert the prompt.');
    } finally {
      setReverting(false);
    }
  };

  return (
    <details
      className="mt-6 border-t border-paper-300 pt-4"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open && versions === null) void load();
      }}
    >
      <summary className="cursor-pointer text-sm font-semibold text-ink-700 select-none">
        Version history
      </summary>
      <div className="mt-3 space-y-2">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!versions && !error && <Spinner />}
        {versions?.length === 0 && (
          <p className="text-xs text-ink-400">
            No earlier versions — this prompt has not been edited since it was created.
          </p>
        )}
        {versions?.map((v, idx) => {
          const isCurrent = idx === 0;
          return (
            <div key={v.id} className="rounded-md border border-paper-200">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="font-mono text-xs font-semibold text-ink-700">v{v.version}</span>
                {isCurrent && (
                  <span className="rounded-full bg-bond-50 px-2 py-0.5 text-[0.65rem] font-semibold text-bond-700 ring-1 ring-bond-200 ring-inset">
                    current
                  </span>
                )}
                {v.model && <span className="font-mono text-xs text-ink-400">{v.model}</span>}
                <span className="tnum ml-auto text-xs text-ink-400">
                  {v.created_by_email ?? 'system'} · {formatDateTime(v.created_at)}
                </span>
                <button
                  onClick={() => setOpenVersion(openVersion === v.version ? null : v.version)}
                  className="cursor-pointer text-xs font-semibold text-bond-600 hover:text-bond-700"
                >
                  {openVersion === v.version ? 'Hide diff' : 'Diff'}
                </button>
                {!isCurrent && (
                  <button
                    onClick={() => void revert(v)}
                    disabled={reverting}
                    className="cursor-pointer text-xs font-semibold text-red-600 hover:text-red-700 disabled:text-ink-300"
                  >
                    Revert
                  </button>
                )}
              </div>
              {openVersion === v.version && (
                <div className="border-t border-paper-200 p-2">
                  <VersionDiff from={v.system_prompt} to={prompt.system_prompt} />
                </div>
              )}
            </div>
          );
        })}
        {versions?.length === 0 && (
          <p className="text-sm text-ink-400">No versions yet — save a change to start the history.</p>
        )}
      </div>
    </details>
  );
}

function PromptCard({
  prompt,
  models,
  onSaved,
}: {
  prompt: BotPrompt;
  models: string[];
  onSaved: () => Promise<void>;
}) {
  const [label, setLabel] = useState(prompt.label);
  const [systemPrompt, setSystemPrompt] = useState(prompt.system_prompt);
  const [model, setModel] = useState(prompt.model ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testInput, setTestInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const dirty =
    label !== prompt.label || systemPrompt !== prompt.system_prompt || model !== (prompt.model ?? '');

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/admin/prompts/${prompt.id}`, {
        method: 'PATCH',
        body: {
          label,
          system_prompt: systemPrompt,
          model: model.trim() === '' ? null : model.trim(),
        },
      });
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the prompt.');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const { test } = await api<{ test: AiTestResult }>(`/admin/prompts/${prompt.id}/test`, {
        method: 'POST',
        body: { input: testInput },
      });
      setTestResult(test);
    } catch (err) {
      setTestError(err instanceof ApiError ? err.message : 'The test run failed.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-display text-lg font-semibold text-ink-900">{prompt.label}</h2>
        <span className="font-mono text-xs text-ink-400">{prompt.pipeline}</span>
        <span className="tnum ml-auto text-xs text-ink-400">Updated {formatDateTime(prompt.updated_at)}</span>
      </div>
      {prompt.description && <p className="mt-1 text-sm text-ink-500">{prompt.description}</p>}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Label">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Model" hint="OpenRouter model id — leave empty to use the default fallback chain.">
          <TextInput
            list={`models-${prompt.id}`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="default fallback chain"
          />
          <datalist id={`models-${prompt.id}`}>
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
      </div>

      <div className="mt-4">
        <Field
          label="System prompt"
          hint="The pipeline's instruction to the model. The user message (documents, params) is composed by the AI service."
        >
          <textarea
            className={`${inputClass} min-h-32 font-mono text-xs leading-relaxed`}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            maxLength={20000}
          />
        </Field>
      </div>

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={saving || !dirty || systemPrompt.trim() === ''}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        {saved && !dirty && <span className="text-sm font-medium text-bond-700">Saved.</span>}
      </div>

      <details className="mt-6 border-t border-paper-300 pt-4">
        <summary className="cursor-pointer text-sm font-semibold text-ink-700 select-none">
          Test this prompt
        </summary>
        <div className="mt-3 space-y-3">
          <Field
            label="Sample input"
            hint="Sent as the user message against the saved system prompt — nothing is persisted. PII is redacted first, and what was struck is reported with the response."
          >
            <textarea
              className={`${inputClass} min-h-24 text-sm`}
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              placeholder="Company: Acme Inc. Uploaded documents: cap_table.csv …"
              maxLength={20000}
            />
          </Field>
          <Button
            variant="secondary"
            onClick={() => void runTest()}
            disabled={testing || testInput.trim() === '' || dirty}
          >
            {testing ? 'Running…' : dirty ? 'Save before testing' : 'Run test'}
          </Button>
          {testError && <ErrorNote>{testError}</ErrorNote>}
          {testResult && (
            <div className="rounded-md border border-paper-300 bg-paper-50 p-4">
              <div className="overline mb-2 text-ink-400">Response · {testResult.model}</div>
              {(() => {
                const struck = describeRedactions(testResult.anonymization?.redacted);
                return struck ? (
                  <p className="mb-2 text-xs text-ink-500">
                    Redacted before sending: {struck}. The model answered the redacted text.
                  </p>
                ) : null;
              })()}
              <pre className="max-h-80 overflow-auto text-xs whitespace-pre-wrap text-ink-800">
                {testResult.content}
              </pre>
            </div>
          )}
        </div>
      </details>

      <VersionHistory
        key={prompt.updated_at}
        prompt={prompt}
        onReverted={async (reverted) => {
          setSystemPrompt(reverted.system_prompt);
          setModel(reverted.model ?? '');
          await onSaved();
        }}
      />
    </section>
  );
}

/** Bot Prompts management — the DB-backed prompt registry behind the AI
 * pipelines: edit each system prompt, pin a model, dry-run changes. */
export function BotPromptsPage() {
  const [prompts, setPrompts] = useState<BotPrompt[] | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { prompts: items } = await api<{ prompts: BotPrompt[] }>('/admin/prompts');
      setPrompts(items);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Bot prompts are operations-only.'
          : 'Could not load the prompt registry.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
    api<{ models: string[] }>('/admin/prompts/models')
      .then((d) => setModels(d.models))
      .catch(() => {});
  }, [load]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!prompts) return <Spinner />;

  return (
    <div>
      <div className="flex items-center gap-2">
        <h1 className="font-display text-3xl font-semibold text-ink-900">Bot prompts</h1>
        <HelpIcon article="ai-agents-overview" className="h-6 w-6 text-sm" />
      </div>
      <p className="mt-2 max-w-2xl text-sm text-ink-500">
        Each AI pipeline runs with a registry-managed system prompt and an optional pinned OpenRouter model.
        Changes apply to the next run — no deploy needed.
      </p>

      <div className="mt-8 space-y-6">
        {prompts.length === 0 && (
          <EmptyState title="No prompts registered">
            Run the database migrations to seed the pipeline prompts.
          </EmptyState>
        )}
        {prompts.map((p) => (
          <PromptCard key={p.id} prompt={p} models={models} onSaved={load} />
        ))}
      </div>
    </div>
  );
}
