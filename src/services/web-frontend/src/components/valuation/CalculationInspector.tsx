import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { CalculationDetail, CalculationStep } from '../../lib/pipeline';
import { ErrorNote, Spinner } from '../ui';

/**
 * The calculation step inspector (409.ai gap §1.3).
 *
 * The panel above this one shows what the engine concluded. This shows how it
 * got there: each pipeline stage with what it consumed, what it produced, and
 * — the part no result document can express — whether it ran at all.
 *
 * That last column is the reason this exists rather than a JSON dump. An
 * approach with zero weight and an approach carried over from a previous
 * per-approach recalculation are both simply missing from `results.approaches`,
 * identically, and they mean opposite things: one was excluded on purpose, the
 * other is a number older than the inputs sitting next to it.
 *
 * The raw request and response are here too, unformatted and copyable, because
 * the end of a real debugging session is usually replaying the exact payload
 * against the engine by hand.
 */

const STATUS_STYLES: Record<CalculationStep['status'], string> = {
  computed: 'bg-bond-50 text-bond-800 ring-bond-200',
  reused: 'bg-amber-50 text-amber-800 ring-amber-200',
  skipped: 'bg-paper-200 text-ink-500 ring-paper-300',
};

const STATUS_TITLES: Record<CalculationStep['status'], string> = {
  computed: 'Ran in this calculation, from the inputs shown.',
  reused: 'Carried over from the previous run — this number is older than the inputs above it.',
  skipped: 'Did not run. See the note.',
};

/** Pretty JSON, or a dash. Nothing here is edited, so a <pre> is the whole widget. */
function Payload({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="min-w-0 flex-1">
      <p className="overline mb-1 text-ink-400">{label}</p>
      <pre className="max-h-64 overflow-auto rounded-md bg-paper-100 p-2.5 text-[0.7rem] leading-relaxed text-ink-800 ring-1 ring-paper-300 ring-inset">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function StepRow({ step }: { step: CalculationStep }) {
  // Collapsed by default. A full trace is seven stages of engine state, and
  // the question a reader arrives with is almost always about one of them.
  const [open, setOpen] = useState(false);
  const hasPayload = step.inputs !== null || step.outputs !== null;

  return (
    <li className="border-t border-paper-300 first:border-t-0">
      <button
        type="button"
        disabled={!hasPayload}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={hasPayload ? open : undefined}
        className="touch:min-h-11 flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left text-sm enabled:cursor-pointer enabled:hover:bg-paper-100"
      >
        <span className="tnum w-5 shrink-0 text-xs text-ink-400">{step.seq}</span>
        <span className="font-semibold text-ink-900">{step.label}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[0.65rem] font-semibold ring-1 ring-inset ${STATUS_STYLES[step.status]}`}
          title={STATUS_TITLES[step.status]}
        >
          {step.status}
        </span>
        <code className="text-[0.7rem] text-ink-400">{step.key}</code>
        <span className="tnum ml-auto text-xs text-ink-400">{step.elapsed_ms.toFixed(2)} ms</span>
        {hasPayload && <span className="text-xs text-ink-400">{open ? '▾' : '▸'}</span>}
      </button>
      {step.note && <p className="px-4 pb-2 pl-12 text-xs text-ink-500">{step.note}</p>}
      {open && hasPayload && (
        <div className="flex flex-wrap gap-4 px-4 pb-4 pl-12">
          <Payload label="Consumed" value={step.inputs} />
          <Payload label="Produced" value={step.outputs} />
        </div>
      )}
    </li>
  );
}

export function CalculationInspector({
  valuationId,
  calculationId,
}: {
  valuationId: string;
  calculationId: string;
}) {
  const [detail, setDetail] = useState<CalculationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    void api<CalculationDetail>(`/valuations/${valuationId}/calculations/${calculationId}`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load the run.');
      });
    return () => {
      cancelled = true;
    };
  }, [valuationId, calculationId]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!detail) return <Spinner />;

  const { calculation, steps, traced } = detail;

  return (
    <div className="space-y-4 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="overline text-ink-400">Engine steps</h3>
        <span className="text-xs text-ink-500">
          {formatDateTime(calculation.created_at)} · engine {calculation.engine_version} ·{' '}
          {calculation.status}
        </span>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="ml-auto cursor-pointer text-xs font-semibold text-bond-700 hover:underline"
        >
          {showRaw ? 'Hide raw payloads' : 'Raw request & response'}
        </button>
      </div>

      {calculation.error && (
        <p className="rounded-md border-l-4 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-900">
          {calculation.error}
        </p>
      )}

      {steps.length > 0 ? (
        <ul className="rounded-lg border border-paper-300">
          {steps.map((step) => (
            <StepRow key={`${step.seq}-${step.key}`} step={step} />
          ))}
        </ul>
      ) : (
        // Two different nothings, and saying which is the entire point: one is
        // history, the other is a run that died before the first stage. An
        // unexplained empty list reads as a broken inspector.
        <p className="text-sm text-ink-500">
          {traced
            ? 'This run recorded no steps — the engine rejected the payload before the pipeline started.'
            : 'This run predates step recording, so only its request and response were kept.'}
        </p>
      )}

      {showRaw && (
        <div className="flex flex-wrap gap-4">
          {/* Exactly what went over the wire and exactly what came back — the
              pair someone replaying a run by hand needs to copy. */}
          <Payload label="Request to the engine" value={detail.request} />
          <Payload label="Response from the engine" value={detail.response} />
        </div>
      )}
    </div>
  );
}
