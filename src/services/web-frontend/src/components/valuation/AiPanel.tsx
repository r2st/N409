import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { AI_PIPELINE_META, AI_PIPELINES, type AiJob, type AiPipeline } from '../../lib/pipeline';
import { Button, EmptyState, ErrorNote, Spinner } from '../ui';

function JobResult({ job }: { job: AiJob }) {
  const result = job.result ?? {};
  if (job.status === 'failed') {
    return <p className="mt-2 text-sm text-red-700">{job.error ?? 'Pipeline failed.'}</p>;
  }

  if (job.pipeline === 'missing_data') {
    const docs = (result.missing_documents as Array<{ label: string }> | undefined) ?? [];
    const params = (result.missing_params as Array<{ label: string }> | undefined) ?? [];
    const gaps = (result.gaps as Array<{ item: string; severity?: string }> | undefined) ?? [];
    const notes = result.notes as string | undefined;
    return (
      <div className="mt-2 space-y-2 text-sm text-ink-800">
        {docs.length + params.length + gaps.length === 0 && <p>Nothing missing — ready to compute.</p>}
        {[...docs, ...params].map((m, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> {m.label}
          </div>
        ))}
        {gaps.map((g, i) => (
          <div key={`g${i}`} className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${g.severity === 'blocking' ? 'bg-red-500' : 'bg-amber-500'}`}
            />
            {g.item}
          </div>
        ))}
        {notes && <p className="text-ink-600">{notes}</p>}
      </div>
    );
  }

  if (job.pipeline === 'extract') {
    const inputs = (result.engine_inputs as Record<string, number> | undefined) ?? {};
    const entries = Object.entries(inputs);
    if (entries.length === 0)
      return <p className="mt-2 text-sm text-ink-600">No values could be extracted.</p>;
    return (
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt className="text-xs text-ink-400">{key.replace(/_/g, ' ')}</dt>
            <dd className="tnum font-semibold text-ink-900">{Number(value).toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    );
  }

  if (job.pipeline === 'summarize') {
    const summaries =
      (result.summaries as
        Array<{ filename: string; summary: string; key_figures?: string[] }> | undefined) ?? [];
    const overall = result.overall as string | undefined;
    if (summaries.length === 0 && !overall)
      return <p className="mt-2 text-sm text-ink-600">Nothing to summarize yet.</p>;
    return (
      <div className="mt-2 space-y-3 text-sm">
        {overall && <p className="text-ink-800">{overall}</p>}
        {summaries.map((s, i) => (
          <div key={i} className="rounded-md border border-paper-300 bg-paper-50 p-3">
            <div className="font-mono text-xs font-semibold text-ink-700">{s.filename}</div>
            <p className="mt-1 text-ink-800">{s.summary}</p>
            {Array.isArray(s.key_figures) && s.key_figures.length > 0 && (
              <ul className="tnum mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-600">
                {s.key_figures.map((f, j) => (
                  <li key={j}>· {f}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    );
  }

  // comparables
  const comps =
    (result.comparables as
      | Array<{
          name: string;
          ticker: string;
          rationale: string;
          revenue_multiple: number | null;
          ebitda_multiple: number | null;
        }>
      | undefined) ?? [];
  return (
    <div className="mt-2 overflow-x-auto">
      {typeof result.sector === 'string' && result.sector && (
        <p className="mb-2 text-sm text-ink-600">Sector: {result.sector}</p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-400">
            <th className="py-1 pr-4 font-semibold">Company</th>
            <th className="py-1 pr-4 font-semibold">EV/Revenue</th>
            <th className="py-1 pr-4 font-semibold">EV/EBITDA</th>
            <th className="py-1 font-semibold">Why</th>
          </tr>
        </thead>
        <tbody>
          {comps.map((c, i) => (
            <tr key={i} className="border-t border-paper-300">
              <td className="py-1.5 pr-4 font-semibold text-ink-900">
                {c.name} {c.ticker && <span className="font-mono text-xs text-ink-400">{c.ticker}</span>}
              </td>
              <td className="tnum py-1.5 pr-4">{c.revenue_multiple ?? '—'}</td>
              <td className="tnum py-1.5 pr-4">{c.ebitda_multiple ?? '—'}</td>
              <td className="py-1.5 text-ink-600">{c.rationale}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {typeof result.caveats === 'string' && result.caveats && (
        <p className="mt-2 text-xs text-ink-400">{result.caveats}</p>
      )}
    </div>
  );
}

/** AI actions: run the pipelines and browse past runs with provenance. */
export function AiPanel({ valuationId }: { valuationId: string }) {
  const [jobs, setJobs] = useState<AiJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<AiPipeline | null>(null);
  const [applying, setApplying] = useState(false);
  const [appliedAt, setAppliedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { jobs: items } = await api<{ jobs: AiJob[] }>(`/valuations/${valuationId}/ai`);
      setJobs(items);
    } catch {
      setError('Could not load AI runs.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (pipeline: AiPipeline) => {
    setError(null);
    setRunning(pipeline);
    try {
      await api(`/valuations/${valuationId}/ai/${pipeline}`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The AI pipeline failed.');
      await load(); // failed runs are recorded too
    } finally {
      setRunning(null);
    }
  };

  const applyExtraction = async () => {
    setError(null);
    setApplying(true);
    try {
      await api(`/valuations/${valuationId}/ai/extract/apply`, { method: 'POST' });
      setAppliedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not apply the extraction.');
    } finally {
      setApplying(false);
    }
  };

  if (!jobs && !error) return <Spinner />;

  const latestExtract = jobs?.find((j) => j.pipeline === 'extract' && j.status === 'succeeded');

  return (
    <div className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {AI_PIPELINES.map((pipeline) => (
          <div
            key={pipeline}
            className="flex flex-col rounded-lg border border-paper-300 bg-surface p-5 shadow-card"
          >
            <h3 className="text-sm font-semibold text-ink-900">{AI_PIPELINE_META[pipeline].label}</h3>
            <p className="mt-1 flex-1 text-xs text-ink-500">{AI_PIPELINE_META[pipeline].description}</p>
            <Button
              className="mt-4"
              variant="secondary"
              disabled={running !== null}
              onClick={() => void run(pipeline)}
            >
              {running === pipeline ? 'Running…' : 'Run'}
            </Button>
          </div>
        ))}
      </div>
      {running && (
        <p className="text-sm text-ink-500">
          Running {AI_PIPELINE_META[running].label.toLowerCase()} — free-tier models can take up to a minute…
        </p>
      )}

      {latestExtract && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-bond-200 bg-bond-50 px-4 py-3">
          <p className="text-sm text-bond-800">
            Apply the latest extraction to the valuation params so every calculation uses it (Set Valuation
            Parameters).
          </p>
          <Button
            variant="secondary"
            className="ml-auto"
            disabled={applying}
            onClick={() => void applyExtraction()}
          >
            {applying ? 'Applying…' : appliedAt ? 'Re-apply to params' : 'Apply to params'}
          </Button>
          {appliedAt && <span className="text-xs font-semibold text-bond-700">Applied ✓</span>}
        </div>
      )}

      {jobs && jobs.length === 0 && (
        <EmptyState title="No AI runs yet">
          Upload documents, then run data extraction to populate the engine inputs.
        </EmptyState>
      )}

      {jobs && jobs.length > 0 && (
        <ol className="space-y-4">
          {jobs.map((job) => (
            <li key={job.id} className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-ink-900">
                  {AI_PIPELINE_META[job.pipeline]?.label ?? job.pipeline}
                </span>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                    job.status === 'succeeded'
                      ? 'bg-bond-50 text-bond-700 ring-bond-200'
                      : job.status === 'failed'
                        ? 'bg-red-50 text-red-800 ring-red-200'
                        : 'bg-sky-50 text-sky-800 ring-sky-200'
                  }`}
                >
                  {job.status}
                </span>
                {(() => {
                  const anon = job.result?.anonymization as
                    { applied?: boolean; redacted?: Record<string, number> } | undefined;
                  const redactedCount = Object.values(anon?.redacted ?? {}).reduce((a, b) => a + b, 0);
                  return anon?.applied ? (
                    <span
                      className="inline-flex items-center rounded-full bg-paper-200 px-2.5 py-0.5 text-xs font-semibold text-ink-600"
                      title="The company name and PII (people, emails, phones, addresses, SSN/EIN) were redacted out of the whole prompt — documents, filenames and the business overview — before it reached the model"
                    >
                      anonymized{redactedCount > 0 ? ` · ${redactedCount}` : ''}
                    </span>
                  ) : null;
                })()}
                <span className="tnum ml-auto text-xs text-ink-400">
                  {formatDateTime(job.created_at)}
                  {job.model && ` · ${job.model}`}
                  {job.prompt_version !== null && ` · prompt v${job.prompt_version}`}
                  {job.latency_ms !== null && ` · ${(job.latency_ms / 1000).toFixed(1)}s`}
                </span>
              </div>
              <JobResult job={job} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
