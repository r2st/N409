import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
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
  const [testResult, setTestResult] = useState<{ model: string; content: string } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const dirty =
    label !== prompt.label ||
    systemPrompt !== prompt.system_prompt ||
    model !== (prompt.model ?? '');

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
      const { test } = await api<{ test: { model: string; content: string } }>(
        `/admin/prompts/${prompt.id}/test`,
        { method: 'POST', body: { input: testInput } },
      );
      setTestResult(test);
    } catch (err) {
      setTestError(err instanceof ApiError ? err.message : 'The test run failed.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-display text-lg font-semibold text-ink-900">{prompt.label}</h2>
        <span className="font-mono text-xs text-ink-400">{prompt.pipeline}</span>
        <span className="tnum ml-auto text-xs text-ink-400">
          Updated {formatDateTime(prompt.updated_at)}
        </span>
      </div>
      {prompt.description && <p className="mt-1 text-sm text-ink-500">{prompt.description}</p>}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Label">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />
        </Field>
        <Field
          label="Model"
          hint="OpenRouter model id — leave empty to use the default fallback chain."
        >
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
            hint="Sent as the user message against the saved system prompt — nothing is persisted."
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
              <pre className="max-h-80 overflow-auto text-xs whitespace-pre-wrap text-ink-800">
                {testResult.content}
              </pre>
            </div>
          )}
        </div>
      </details>
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
      <h1 className="font-display text-3xl font-semibold text-ink-900">Bot prompts</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-500">
        Each AI pipeline runs with a registry-managed system prompt and an optional pinned
        OpenRouter model. Changes apply to the next run — no deploy needed.
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
