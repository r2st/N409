import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface Explanation {
  summary: string;
  methodology: Array<{ approach: string; weight: number | null; explanation: string }>;
  drivers: string[];
  caveats: string;
}

interface ExplanationResponse {
  explanation: Explanation | null;
  model: string | null;
  generated_at: string | null;
}

/**
 * Plain-English valuation summary (IMPROVEMENTS_RESEARCH §4.5). Renders
 * nothing until the API exposes an explanation to this role — clients get it
 * with the same visibility as the report itself.
 */
export function ExplanationCard({ valuationId }: { valuationId: string }) {
  const [explanation, setExplanation] = useState<Explanation | null>(null);

  useEffect(() => {
    void api<ExplanationResponse>(`/valuations/${valuationId}/explanation`)
      .then((res) => setExplanation(res.explanation?.summary ? res.explanation : null))
      .catch(() => setExplanation(null)); // purely additive — never break the report view
  }, [valuationId]);

  if (!explanation) return null;

  return (
    <section data-testid="explanation-card" className="rounded-lg border border-bond-200 bg-bond-50/60 p-5">
      <h3 className="overline mb-3 text-bond-700">In plain English</h3>
      <p className="text-sm leading-relaxed whitespace-pre-line text-ink-800">{explanation.summary}</p>

      {explanation.methodology.length > 0 && (
        <dl className="mt-4 space-y-2">
          {explanation.methodology.map((m) => (
            <div key={m.approach} className="text-sm">
              <dt className="inline font-semibold text-ink-900">
                {m.approach}
                {m.weight != null && (
                  <span className="tnum ml-1 text-xs font-medium text-ink-400">
                    ({Math.round(m.weight * 100)}%)
                  </span>
                )}
                {': '}
              </dt>
              <dd className="inline text-ink-700">{m.explanation}</dd>
            </div>
          ))}
        </dl>
      )}

      {explanation.drivers.length > 0 && (
        <p className="mt-4 text-sm text-ink-700">
          <span className="font-semibold text-ink-900">What moved the value: </span>
          {explanation.drivers.join(' · ')}
        </p>
      )}

      {explanation.caveats && <p className="mt-3 text-xs text-ink-400 italic">{explanation.caveats}</p>}
    </section>
  );
}
