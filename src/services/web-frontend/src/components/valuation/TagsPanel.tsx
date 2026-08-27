import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button, ErrorNote, Select, Spinner, WriteGate } from '../../components/ui';
import type { TagCatalogueCategory, ValuationTag } from '../../lib/tags';

/**
 * Engagement tags — the browser half of 409.ai parity gap #23.
 *
 * The vocabulary, the exclusivity rule, the AI `tagging` agent and the list
 * filter that reads an accepted tag were all built server-side and shipped with
 * nothing to drive them: `routes/valuationTags.ts` says "the catalogue as the
 * UI renders it" above a payload no UI had ever asked for. This is that UI.
 *
 * Three rules from the API are restated here as *shape* rather than as prose,
 * because a control that cannot express the wrong thing beats a message
 * explaining why it was refused:
 *
 *   * the catalogue is closed, so tags are chosen from a picker built out of
 *     `/tag-catalogue` and never typed — the server's `'x' is not a tag in the
 *     catalogue` 422 is a backstop for other clients, not this one;
 *   * an AI-sourced tag is rejected, never deleted, so the row's own `source`
 *     decides which of the two controls it gets;
 *   * a suggestion is a claim nobody has made yet, so suggested tags are listed
 *     apart from accepted ones rather than mixed in and coloured differently.
 *
 * What is deliberately *not* mirrored is exclusivity. At most one accepted tag
 * from `stage` or `revenue` is enforced by the server by demoting the
 * incumbent, and the panel simply re-reads the list afterwards: predicting the
 * demotion here would be a second copy of a rule that already has one home, and
 * the failure mode of getting it wrong is a screen that disagrees with the row.
 */

type Phase = 'drafting' | 'applying';

interface TagsResponse {
  tags: ValuationTag[];
  categories: TagCatalogueCategory[];
}

export function TagsPanel({
  valuationId,
  canWrite,
}: {
  valuationId: string;
  /** Ops, on an engagement that is not retired. Writing is operations-only. */
  canWrite: boolean;
}) {
  const [data, setData] = useState<TagsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const [phase, setPhase] = useState<Phase | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<Partial<TagsResponse>>(`/valuations/${valuationId}/tags`);
      // A 200 carrying the wrong shape is a failure too, and the only one that
      // can reach the render. `res.tags.filter` on an absent field throws
      // inside React's render, which takes the whole tab down through the
      // route boundary — so the check is here, where it is still a load error
      // and can be reported as one.
      if (!Array.isArray(res.tags) || !Array.isArray(res.categories)) {
        throw new TypeError('malformed tag payload');
      }
      setData({ tags: res.tags, categories: res.categories });
      setLoadError(null);
    } catch (err) {
      // Surfaced, not swallowed: an empty tag list and a tag list that failed
      // to load render identically, and only one of them means "untagged".
      setLoadError(err instanceof ApiError ? err.message : 'Could not load the engagement tags.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (slug: string, run: () => Promise<unknown>) => {
    setBusy(slug);
    setError(null);
    try {
      await run();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the tag.');
    } finally {
      setBusy(null);
    }
  };

  const decide = (slug: string, status: 'accepted' | 'rejected') =>
    act(slug, () =>
      api(`/valuations/${valuationId}/tags/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        body: { status },
      }),
    );

  const remove = (slug: string) =>
    act(slug, () => api(`/valuations/${valuationId}/tags/${encodeURIComponent(slug)}`, { method: 'DELETE' }));

  const add = () => {
    if (!choice) return;
    const slug = choice;
    return act(slug, async () => {
      await api(`/valuations/${valuationId}/tags`, { method: 'POST', body: { slug } });
      setChoice('');
    });
  };

  /**
   * Run the `tagging` agent and apply its output in one press.
   *
   * Two calls rather than one because the server keeps them separate on
   * purpose — a run is re-appliable and an apply is re-runnable — but an
   * analyst pressing "Suggest tags" means both, and the phase label says which
   * half is in flight so a slow model does not look like a hung button.
   */
  const suggest = async () => {
    setError(null);
    setNote(null);
    setPhase('drafting');
    try {
      await api(`/valuations/${valuationId}/ai/tagging`, { method: 'POST' });
      setPhase('applying');
      const res = await api<{ tags: ValuationTag[]; applied: string[]; unknown: string[] }>(
        `/valuations/${valuationId}/ai/tagging/apply`,
        { method: 'POST' },
      );
      await load();
      // `unknown` is the model asking for a tag the catalogue does not carry.
      // The server returns it rather than logging it precisely so the operator
      // holding the screen — the person who can extend the vocabulary — sees
      // it; dropping it here would put it back in a log nobody reads.
      setNote(
        `Suggested ${res.applied.length} tag${res.applied.length === 1 ? '' : 's'} for review.` +
          (res.unknown.length > 0
            ? ` The model also proposed ${res.unknown.join(', ')}, which ${
                res.unknown.length === 1 ? 'is not a tag' : 'are not tags'
              } in the catalogue.`
            : ''),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not suggest tags.');
    } finally {
      setPhase(null);
    }
  };

  if (loadError !== null) {
    return (
      <section
        className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
        data-testid="tags-panel"
      >
        <Header />
        <ErrorNote>{loadError}</ErrorNote>
      </section>
    );
  }
  if (data === null) {
    return (
      <section
        className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
        data-testid="tags-panel"
      >
        <Header />
        <Spinner label="Loading tags…" />
      </section>
    );
  }

  const accepted = data.tags.filter((t) => t.status === 'accepted');
  const suggested = data.tags.filter((t) => t.status === 'suggested');
  const rejected = data.tags.filter((t) => t.status === 'rejected');
  // Only tags with no row at all — re-proposing one that is already suggested
  // or was rejected would either be a no-op or would quietly reopen a decision
  // somebody made, and the picker should not offer either.
  const held = new Set(data.tags.map((t) => t.slug));

  return (
    <section
      className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
      data-testid="tags-panel"
    >
      <Header />

      {suggested.length > 0 && (
        <div className="mt-4">
          <h3 className="overline mb-2 text-ink-400">Suggested by the tagging agent</h3>
          <ul className="divide-y divide-paper-300">
            {suggested.map((tag) => (
              <li key={tag.slug} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink-900">
                    {tag.label}
                    {tag.confidence !== null && (
                      <span className="tnum ml-2 text-xs font-normal text-ink-500">
                        {Math.round(tag.confidence * 100)}% confident
                      </span>
                    )}
                  </p>
                  {tag.rationale !== null && <p className="mt-0.5 text-sm text-ink-600">{tag.rationale}</p>}
                  {tag.evidence !== null && tag.evidence.length > 0 && (
                    <p className="mt-0.5 text-xs text-ink-500">Read from: {tag.evidence.join(', ')}</p>
                  )}
                </div>
                <WriteGate closed={!canWrite}>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => void decide(tag.slug, 'accepted')}
                    >
                      {busy === tag.slug ? 'Working…' : 'Accept'}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void decide(tag.slug, 'rejected')}
                    >
                      Reject
                    </Button>
                  </div>
                </WriteGate>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4">
        <h3 className="overline mb-2 text-ink-400">Accepted</h3>
        {accepted.length === 0 ? (
          <p className="text-sm text-ink-500">
            No tags yet. A tag drives the engagement list filter and the precedent query, so an untagged file
            is one nobody will find by what it is.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {accepted.map((tag) => (
              <li
                key={tag.slug}
                className="flex items-center gap-2 rounded-full bg-bond-50 py-1 pr-1 pl-3 text-sm font-semibold text-bond-800 ring-1 ring-bond-200 ring-inset"
                title={tag.definition ?? undefined}
              >
                <span>{tag.label}</span>
                {!tag.known && (
                  // A slug that has left the catalogue still records a decision
                  // somebody made. Shown, and labelled as what it is.
                  <span className="text-xs font-normal text-ink-500">(retired tag)</span>
                )}
                <span className="text-xs font-normal text-ink-500">
                  {tag.source === 'ai' ? 'AI · accepted' : 'analyst'}
                </span>
                <WriteGate closed={!canWrite}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void (tag.source === 'ai' ? decide(tag.slug, 'rejected') : remove(tag.slug))
                    }
                    className="cursor-pointer rounded-full px-2 py-0.5 text-xs text-ink-500 hover:bg-bond-100 hover:text-ink-800 disabled:cursor-not-allowed"
                    // An AI row is rejected rather than deleted, so the two
                    // controls are named for what they actually do. One label
                    // over both would make the refusal look like a bug.
                    aria-label={tag.source === 'ai' ? `Reject ${tag.label}` : `Remove ${tag.label}`}
                  >
                    {tag.source === 'ai' ? 'Reject' : 'Remove'}
                  </button>
                </WriteGate>
              </li>
            ))}
          </ul>
        )}
      </div>

      {rejected.length > 0 && (
        <div className="mt-4">
          <h3 className="overline mb-2 text-ink-400">Rejected</h3>
          <ul className="flex flex-wrap gap-2">
            {rejected.map((tag) => (
              <li
                key={tag.slug}
                className="flex items-center gap-2 rounded-full bg-paper-200 py-1 pr-1 pl-3 text-sm text-ink-500 ring-1 ring-paper-400 ring-inset"
                title={tag.definition ?? undefined}
              >
                <span className="line-through">{tag.label}</span>
                <WriteGate closed={!canWrite}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void decide(tag.slug, 'accepted')}
                    className="cursor-pointer rounded-full px-2 py-0.5 text-xs text-ink-500 hover:bg-paper-300 hover:text-ink-800 disabled:cursor-not-allowed"
                    aria-label={`Accept ${tag.label}`}
                  >
                    Accept
                  </button>
                </WriteGate>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error !== null && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {note !== null && <p className="mt-4 text-sm text-ink-600">{note}</p>}

      {canWrite && (
        <WriteGate closed={busy !== null || phase !== null}>
          <div className="mt-5 flex flex-wrap items-end gap-2 border-t border-paper-300 pt-4">
            <label className="block text-xs font-semibold text-ink-600">
              Add a tag
              <Select
                aria-label="Add a tag"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                className="mt-1 !w-auto min-w-56"
              >
                <option value="">Choose a tag…</option>
                {data.categories.map((category) => (
                  <optgroup
                    key={category.category}
                    label={category.exclusive ? `${category.label} (one only)` : category.label}
                  >
                    {category.tags
                      .filter((t) => !held.has(t.slug))
                      .map((t) => (
                        <option key={t.slug} value={t.slug} title={t.definition}>
                          {t.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
            </label>
            <Button variant="secondary" disabled={choice === ''} onClick={() => void add()}>
              Add
            </Button>
            <Button variant="ghost" onClick={() => void suggest()} className="ml-auto">
              {phase === 'drafting'
                ? 'Reading the engagement…'
                : phase === 'applying'
                  ? 'Applying…'
                  : 'Suggest tags with AI'}
            </Button>
          </div>
        </WriteGate>
      )}
    </section>
  );
}

function Header() {
  return (
    <>
      <h2 className="overline mb-1 text-ink-400">Engagement tags</h2>
      <p className="text-sm text-ink-600">
        How this engagement is classified — stage, revenue, business model and the rest. Tags drive the list
        filter and the precedent query, and an accepted tag is a claim the firm is making.
      </p>
    </>
  );
}
