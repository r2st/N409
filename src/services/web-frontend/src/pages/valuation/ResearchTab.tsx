import { useCallback, useEffect, useState } from 'react';
import { api, describeActionFailure } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { formatDateTime } from '../../lib/format';
import { externalHref } from '../../lib/m2';
import { useWorkspace } from './ValuationWorkspace';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  ListTruncationNote,
  LoadError,
  LoadingBlock,
  Select,
  Skeleton,
  SkeletonText,
  TextInput,
  WriteGate,
  useRetry,
} from '../../components/ui';

/**
 * Web-grounded market research (design §12.3).
 *
 * One card per topic, each showing the answer, the sources it came from as
 * links, and when it was retrieved. The citations are the point of the tab, not
 * decoration: a market multiple a reviewer cannot follow back to a publisher is
 * the model's recollection in a more confident voice, and this is the surface
 * where that distinction is visible before it reaches a report.
 */

interface Topic {
  topic: string;
  label: string;
  description: string;
  regionScoped: boolean;
  acceptsSubject: boolean;
}

interface Citation {
  url: string;
  title?: string;
  date?: string;
}

interface ResearchRow {
  id: string;
  topic: string;
  region: string | null;
  question: string;
  answer: string;
  citations: Citation[];
  model: string;
  created_at: string;
  stale: boolean;
  grounded: boolean;
  /**
   * False when the sources are real but nothing usable wrote them up — the
   * search ran and either the synthesis model was unavailable or its answer was
   * truncated at the output cap. Such a row is never grounded, and
   * the two reasons a row can be ungrounded read very differently to an
   * analyst: "the public record has nothing on this" is an answer, "we could
   * not summarise what it had" is a retry.
   */
  synthesized?: boolean;
}

interface TopicsResponse {
  topics: Topic[];
  regions: Array<{ key: string; label: string }>;
  stale_days: number;
}

interface ResearchResponse {
  research: ResearchRow[];
  stale_days: number;
  can_run: boolean;
  /** True when more research rows exist than this page carries. */
  truncated: boolean;
  page_limit: number;
}

function Citations({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) {
    return (
      <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200 ring-inset">
        No sources returned. An answer with no citations is an ordinary completion — do not quote it in a
        report.
      </p>
    );
  }
  return (
    <div className="mt-3">
      <div className="overline mb-1.5 text-ink-400">Sources</div>
      <ul className="space-y-1">
        {citations.map((c) => {
          // The URL came from a search backend by way of a model, and lands in
          // an `href`. Anything that is not absolute http(s) is shown as the
          // text it is rather than made clickable — a source that cannot be
          // linked is still a source the analyst has to be able to read.
          const href = externalHref(c.url);
          const label = c.title?.trim() || c.url;
          return (
            <li key={c.url} className="text-xs">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-bond-600 hover:text-bond-700 hover:underline"
                >
                  {label}
                </a>
              ) : (
                <span className="text-ink-500" title="Not a link this source can be followed to">
                  {label}
                </span>
              )}
              {c.date && <span className="tnum ml-2 text-ink-400">{c.date}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TopicCard({
  topic,
  row,
  regions,
  canRun,
  retired,
  staleDays,
  onRun,
  running,
}: {
  topic: Topic;
  row: ResearchRow | undefined;
  regions: Array<{ key: string; label: string }>;
  canRun: boolean;
  retired: boolean;
  staleDays: number;
  onRun: (body: Record<string, unknown>) => Promise<void>;
  running: boolean;
}) {
  const [region, setRegion] = useState(row?.region ?? 'us');
  const [subject, setSubject] = useState('');

  const run = () =>
    onRun({
      topic: topic.topic,
      ...(topic.regionScoped ? { region } : {}),
      ...(topic.acceptsSubject ? { subject: subject.trim() } : {}),
    });

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-display text-lg font-semibold text-ink-900">{topic.label}</h2>
        {row?.region && (
          <span className="rounded-full bg-paper-200 px-2 py-0.5 text-[0.65rem] font-semibold text-ink-600 uppercase">
            {row.region}
          </span>
        )}
        {row?.stale && (
          <span
            className="rounded-full bg-amber-50 px-2 py-0.5 text-[0.65rem] font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset"
            title={`Retrieved more than ${staleDays} days ago`}
          >
            stale
          </span>
        )}
        {row?.synthesized === false && (
          <span
            className="rounded-full bg-red-50 px-2 py-0.5 text-[0.65rem] font-semibold text-red-800 ring-1 ring-red-200 ring-inset"
            title="The search returned these sources but no usable write-up came back — the synthesis model was unavailable, or its answer was cut off at the output cap. Nothing complete has been written from them, so this topic is excluded from report drafting and from the sources exhibit. The answer says which, and what to do about it."
          >
            not summarised
          </span>
        )}
        {row && (
          <span className="tnum ml-auto text-xs text-ink-400">
            {formatDateTime(row.created_at)} · {row.model}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-500">{topic.description}</p>

      {row ? (
        <>
          <p className="mt-4 text-sm whitespace-pre-wrap text-ink-800">{row.answer}</p>
          <Citations citations={row.citations} />
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-semibold text-ink-400 select-none">
              What was asked
            </summary>
            {/*
             * Shown, not hidden: this is the evidence that only public fields
             * reached the search provider. An auditor asking "what did you send
             * about my client" gets the literal question back.
             */}
            <p className="mt-1.5 text-xs text-ink-500">{row.question}</p>
          </details>
        </>
      ) : (
        <p className="mt-4 text-sm text-ink-400">Not retrieved yet.</p>
      )}

      {canRun && (
        <WriteGate closed={retired}>
          <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-paper-200 pt-4">
            {topic.regionScoped && (
              <Field label="Market">
                <Select value={region} onChange={(e) => setRegion(e.target.value)}>
                  {regions.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {topic.acceptsSubject && (
              <Field
                label="Guideline company"
                hint="A public comparable. Never this engagement’s own company — that is confidential."
              >
                <TextInput
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="ABB Ltd"
                  maxLength={120}
                />
              </Field>
            )}
            <Button
              variant="secondary"
              onClick={() => void run()}
              disabled={running || (topic.acceptsSubject && subject.trim().length < 2)}
            >
              {running ? 'Researching…' : row ? 'Refresh' : 'Run research'}
            </Button>
          </div>
        </WriteGate>
      )}
    </section>
  );
}

export function ResearchTab() {
  const { valuation, retired } = useWorkspace();
  const { user } = useAuth();
  const ops = isOps(user);
  const [meta, setMeta] = useState<TopicsResponse | null>(null);
  /*
   * The topic registry failing is not the same as there being no topics, and
   * the empty state says the second out loud: "No market research yet — set the
   * industry on the Company tab, then run a topic." An analyst who follows that
   * goes to the Company tab, finds the industry already set, and comes back to
   * the same page with no topic to run. The instruction is unfollowable because
   * the list it refers to is the one that failed to arrive.
   */
  const [topicsFailed, setTopicsFailed] = useState(false);
  const [data, setData] = useState<ResearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<ResearchResponse>(`/valuations/${valuation.id}/research`));
    } catch (err) {
      setError(describeActionFailure(err, 'Could not load market research.'));
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load, token]);

  useEffect(() => {
    if (!ops) return;
    api<TopicsResponse>('/research/topics')
      .then(setMeta)
      .catch(() => setTopicsFailed(true));
  }, [ops]);

  const run = async (body: Record<string, unknown>) => {
    setRunning(String(body.topic));
    setError(null);
    try {
      await api(`/valuations/${valuation.id}/research`, { method: 'POST', body });
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'The research run failed.'));
    } finally {
      setRunning(null);
    }
  };

  const refreshAll = async () => {
    setRunning('__all');
    setError(null);
    try {
      await api(`/valuations/${valuation.id}/research/refresh-all`, { method: 'POST', body: {} });
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'The refresh failed.'));
    } finally {
      setRunning(null);
    }
  };

  if (error && !data) return <LoadError message={error} {...retryProps} />;
  if (!data)
    return (
      <LoadingBlock label="Loading market research…" className="space-y-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card" aria-hidden>
            <Skeleton className="h-5 w-56" />
            <SkeletonText lines={3} className="mt-4" />
          </div>
        ))}
      </LoadingBlock>
    );

  const byTopic = new Map(data.research.map((r) => [`${r.topic}:${r.region ?? ''}`, r]));
  const latestFor = (topic: string): ResearchRow | undefined => data.research.find((r) => r.topic === topic);

  // Clients see only what was retrieved; running it spends money, so the whole
  // control column is ops-only rather than disabled-and-visible.
  const topics = meta?.topics ?? [];
  /*
   * Whether the registry has finished answering. A client never asks for it —
   * the run controls are ops-only — so for them `meta` stays null for good and
   * the answer is "yes, and there are none". For ops it is null twice over:
   * before the reply and after a failed one, and only the first of those was
   * ever distinguished from an empty registry.
   */
  const topicsSettled = !ops || meta !== null || topicsFailed;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-500">
          Web-grounded research from public sources, with citations. Questions are built from the industry and
          classification code alone — the company name, cap table and financials never reach a search
          provider. Research retrieved more than {data.stale_days} days before the measurement date is flagged
          stale.
        </p>
        {data.can_run && topics.length > 0 && (
          <WriteGate closed={retired}>
            <Button onClick={() => void refreshAll()} disabled={running !== null}>
              {running === '__all' ? 'Refreshing…' : 'Refresh all'}
            </Button>
          </WriteGate>
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {topicsFailed && (
        <p className="text-sm text-ink-400">
          The list of research topics could not be loaded, so none are offered here. Reload the page to try
          again — this says nothing about whether research has been run for this engagement.
        </p>
      )}

      {topicsSettled && topics.length === 0 && data.research.length === 0 && !topicsFailed && (
        <EmptyState title="No market research yet">
          {data.can_run
            ? 'Set the industry on the Company tab, then run a topic.'
            : 'Nothing has been retrieved for this engagement.'}
        </EmptyState>
      )}

      {topics.map((topic) => (
        <TopicCard
          key={topic.topic}
          topic={topic}
          row={latestFor(topic.topic)}
          regions={meta?.regions ?? []}
          canRun={data.can_run}
          retired={retired}
          staleDays={data.stale_days}
          onRun={run}
          running={running === topic.topic || running === '__all'}
        />
      ))}

      {/* A client with no topic registry still sees what was retrieved. */}
      {topicsSettled &&
        topics.length === 0 &&
        data.research.map((row) => (
          <section key={row.id} className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="font-display text-lg font-semibold text-ink-900">
                {row.topic.replace(/_/g, ' ')}
              </h2>
              <span className="tnum ml-auto text-xs text-ink-400">{formatDateTime(row.created_at)}</span>
            </div>
            <p className="mt-3 text-sm whitespace-pre-wrap text-ink-800">{row.answer}</p>
            <Citations citations={row.citations} />
          </section>
        ))}

      {/* Newest first, so a truncated log has lost the oldest research —
          the supersede chain an auditor reads backwards through. */}
      <ListTruncationNote
        truncated={data.truncated}
        shown={data.research.length}
        noun="research answers"
        hint="the earliest runs are not listed"
      />

      {byTopic.size > 0 && data.research.some((r) => !r.grounded) && (
        <p className="text-xs text-ink-400">
          Ungrounded answers are excluded from report drafting and from the sources exhibit.
          {/*
           * Named separately because it is the one ungrounded case that is
           * worth acting on: the sources are there and a re-run will usually
           * write them up, whereas a topic the public record does not cover
           * will come back empty however many times it is asked.
           */}
          {data.research.some((r) => r.synthesized === false) &&
            ' Topics marked “not summarised” kept their sources — re-run them to get a written answer.'}
        </p>
      )}
    </div>
  );
}
