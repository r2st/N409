import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken, ifMatch } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import {
  downloadPdf,
  sanitizeHtml,
  type Report,
  type ReportContent,
  type ReportSection,
  type ReportVersionSummary,
} from '../../lib/m2';
import { formatDateTime } from '../../lib/format';
import { filenameStem } from '../../lib/useDownload';
import { useUnsavedChanges } from '../../lib/unsavedChanges';
import { useWorkspace } from './ValuationWorkspace';
import { RichTextEditor } from '../../components/RichTextEditor';
import { ExplanationCard } from '../../components/valuation/ExplanationCard';
import { Button, EmptyState, ErrorNote, Spinner, TextInput, WriteGate } from '../../components/ui';

const STATUS_LABELS: Record<Report['status'], string> = {
  draft: 'Draft',
  accepted: 'Accepted',
  changes: 'Changes requested',
  published: 'Published',
};

/** DOM id of a chapter's card, so the outline can link straight at it. */
const sectionDomId = (key: string) => `report-section-${key}`;

/**
 * Jump list for the chapters (409.ai §12.2 "report structure").
 *
 * A finished 409A runs to twenty-seven chapters and some fifteen thousand
 * pixels; without this the only way to reach "Discount for Lack of
 * Marketability" is to scroll past twenty rich-text editors looking for it.
 * The list carries the number each chapter will hold in the PDF, and marks the
 * omitted ones — so it doubles as the answer to "what is actually in this
 * document", which was otherwise only obtainable by rendering it.
 *
 * Plain `#` anchors rather than scroll handlers: they are focusable, they work
 * with the keyboard and with a middle-click, and the browser's own
 * `scroll-behavior: smooth` (index.css) animates them.
 */
function ReportOutline({
  sections,
  numberOf,
}: {
  sections: ReportSection[];
  numberOf: (section: ReportSection) => number | null;
}) {
  return (
    <nav aria-label="Report sections" data-testid="report-outline">
      <h2 className="overline mb-3 text-ink-400">Sections</h2>
      <ol className="space-y-0.5">
        {sections.map((section) => {
          const number = numberOf(section);
          return (
            <li key={section.key}>
              <a
                href={`#${sectionDomId(section.key)}`}
                className={`flex gap-2 rounded px-2 py-1 text-sm hover:bg-paper-100 focus-visible:ring-2 focus-visible:ring-bond-600/30 focus-visible:outline-none ${
                  number === null ? 'text-ink-400' : 'text-ink-700'
                }`}
              >
                <span className="tnum w-5 shrink-0 text-right text-xs text-ink-400">{number ?? '—'}</span>
                <span className={number === null ? 'line-through decoration-ink-300' : ''}>
                  {section.heading || 'Untitled'}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Report workspace: WYSIWYG section editor (ops), version history with
 * restore, PDF render + download. Clients get a read-only view once the
 * report is drafted.
 */
export function ReportTab() {
  const { valuation, retired } = useWorkspace();
  const { user } = useAuth();
  const ops = isOps(user);

  const [report, setReport] = useState<Report | null>(null);
  const [content, setContent] = useState<ReportContent | null>(null);
  const [versions, setVersions] = useState<ReportVersionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The version somebody else saved while this editor was open.
   *
   * Set when a save is refused, and it is the only piece of conflict state the
   * tab keeps, because the response to a conflict here cannot be the response
   * the valuation form gives. There, a 409 reloads the page — the fields are a
   * dozen values that can be retyped from the source document. Here the refused
   * payload is the chapters, so reloading is precisely how they are lost. The
   * draft stays on screen, the button says what saving it would now do, and the
   * analyst decides.
   */
  const [conflictedWith, setConflictedWith] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ report: Report; version: { version: number; content: ReportContent } | null }>(
        `/valuations/${valuation.id}/report`,
      );
      setReport(res.report);
      setContent(res.version?.content ?? null);
      setDirty(false);
      setConflictedWith(null);
      if (ops) {
        const { versions: v } = await api<{ versions: ReportVersionSummary[] }>(
          `/valuations/${valuation.id}/report/versions`,
        );
        setVersions(v);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setReport(null); // no report shared with this role yet
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load the report.');
      }
    } finally {
      setLoaded(true);
    }
  }, [valuation.id, ops]);

  useEffect(() => {
    void load();
  }, [load]);

  // Editing happens in place and saving is explicit, so until this point the
  // only thing standing between a half-written chapter and the tab strip was
  // the analyst remembering. Declared before the early returns below, because a
  // hook cannot be conditional.
  useUnsavedChanges(dirty, 'This report has unsaved edits. Leave the page and they will be lost.');

  if (!loaded) return <Spinner />;
  if (error && !report) return <ErrorNote>{error}</ErrorNote>;
  if (!report || !content) {
    return (
      <EmptyState title="No report yet">
        The report becomes available here once the analyst shares a draft.
      </EmptyState>
    );
  }

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${label}.`);
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      try {
        const res = await api<{ report: Report; version: { version: number; content: ReportContent } }>(
          `/valuations/${valuation.id}/report`,
          {
            method: 'PUT',
            body: { content },
            // The version this editor was loaded at. Refused with a 409 if
            // anyone saved since — `saveVersion` appends, so without this the
            // other analyst's chapters stay in the history but stop being the
            // report anything reads, renders or downloads, and nobody is told.
            headers: ifMatch(report.current_version),
          },
        );
        setReport(res.report);
        setContent(res.version.content);
        setDirty(false);
        setConflictedWith(null);
        setNotice(`Saved as version ${res.version.version}.`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Take their version as the new base — but only the pointer. The body
          // on screen is this analyst's unsaved work and is the one thing that
          // must survive. With the pointer current, a second click saves on top
          // of theirs deliberately, and still conflicts if a third writer lands
          // in between.
          const fresh = await api<{ report: Report }>(`/valuations/${valuation.id}/report`);
          setReport(fresh.report);
          setConflictedWith(fresh.report.current_version);
        }
        throw err;
      } finally {
        // Their save is in the history either way, and the panel is how this
        // analyst reads it before deciding to supersede it.
        if (ops) {
          // Cosmetic, and in the failure path — a panel that would not refresh
          // must not replace the error explaining why the save was refused.
          await api<{ versions: ReportVersionSummary[] }>(`/valuations/${valuation.id}/report/versions`)
            .then(({ versions: v }) => setVersions(v))
            .catch(() => {});
        }
      }
    });

  const render = () =>
    run('render', async () => {
      const res = await api<{ version: number; size_bytes: number }>(
        `/valuations/${valuation.id}/report/render`,
        { method: 'POST' },
      );
      setNotice(`Rendered v${res.version} (${Math.round(res.size_bytes / 1024)} KB).`);
      await load();
    });

  /**
   * Draft the prose from the finished calculation, and put it in.
   *
   * The chapters it fills are the ones nobody has written — measured against
   * the report's own v1 skeleton — so clicking this on a report an analyst has
   * been editing fills the gaps and leaves their work alone. That is why it can
   * be a plain button rather than a confirmation dialog.
   */
  const drafting = () =>
    run('draft', async () => {
      const res = await api<{
        changed: boolean;
        version: number;
        applied: Array<{ section_key: string | null; outcome: string }>;
      }>(`/valuations/${valuation.id}/report/narrative`, { method: 'POST', body: {} });
      const written = res.applied.filter((a) => a.outcome === 'written').length;
      const kept = res.applied.filter((a) => a.outcome === 'kept').length;
      setNotice(
        res.changed
          ? `Drafted ${written} section${written === 1 ? '' : 's'} as version ${res.version}` +
              (kept > 0 ? ` · ${kept} you had already written were left alone.` : '.')
          : 'Nothing to draft — every section the agent covers has already been written.',
      );
      await load();
    });

  const download = () =>
    run('download', () =>
      downloadPdf(
        `/valuations/${valuation.id}/report.pdf`,
        `${filenameStem(valuation.company_name)}_report_v${report.current_version}.pdf`,
        getToken(),
      ),
    );

  const restore = (version: number) =>
    run('restore', async () => {
      await api(`/valuations/${valuation.id}/report/revert`, {
        method: 'POST',
        body: { version },
        // A revert appends the old body as the new current version, so it is a
        // save like any other and races the same editors.
        headers: ifMatch(report.current_version),
      });
      setNotice(`Restored version ${version} as a new version.`);
      await load();
    });

  const updateSection = (
    index: number,
    patch: Partial<{ heading: string; html: string; hidden: boolean }>,
  ) => {
    setContent((cur) => {
      if (!cur) return cur;
      const sections = cur.sections.map((s, i) => (i === index ? { ...s, ...patch } : s));
      return { ...cur, sections };
    });
    setDirty(true);
  };

  /*
   * What the deliverable will contain, which is what both halves of this page
   * are numbered against.
   *
   * The analyst still sees every chapter — hiding one has to be reversible from
   * the same place it was done — but the number beside it is the number it will
   * carry in the PDF, so a hidden chapter takes none. A reader sees only the
   * visible set, because the draft shared with them is a preview of the
   * document, not of the editor.
   */
  const visible = content.sections.filter((s) => s.hidden !== true);
  /** The chapter's number in the rendered PDF; null when it is omitted. */
  const numberOf = (section: ReportSection): number | null => {
    const at = visible.indexOf(section);
    return at === -1 ? null : at + 1;
  };
  const shown = ops ? content.sections : visible;
  /*
   * The engagement's state, not the report's.
   *
   * `report.status` tracks the editorial round trip (draft → accepted →
   * changes) and reads 'published' as soon as an analyst marks the prose done.
   * What decides whether the PDF carries a stamp is the *engagement* reaching
   * `published`, which is the transition the signature and the QA gate stand
   * in front of — so this has to be the same fact the renderer keys on, or the
   * banner and the document disagree about what the reader is holding.
   */
  const published = valuation.state === 'published';

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-6">
        {/*
          What the reader is holding, said before they download it.

          The deliverable is readable here from `drafted` — before the QA review
          closes, before the signature, before publication — and the PDF it
          produces is stamped DRAFT on every page for exactly that reason. The
          page it was downloaded from should say the same thing: a client who
          forwards this to their auditor should know what they are forwarding,
          and finding out from a diagonal stamp after the fact is finding out
          too late.

          Ops are excluded deliberately. They have the state badge, the version
          history and the render button in front of them, and a banner telling
          the author of a draft that it is a draft is noise on every visit.
        */}
        {!ops && !published && (
          <p
            role="status"
            data-testid="report-draft-notice"
            className="rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800"
          >
            <span className="font-semibold">This report is a draft.</span> The figures and wording may still
            change, and every page of the PDF you download is marked as such. The final report is issued when
            the engagement is published.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-ink-400">
            <span className="rounded border border-ink-200 bg-surface px-2 py-0.5 font-mono font-semibold text-ink-700">
              {report.template_version}
            </span>
            <span>v{report.current_version}</span>
            <span>· {STATUS_LABELS[report.status]}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void download()} disabled={busy !== null}>
              {busy === 'download' ? 'Preparing…' : 'Download PDF'}
            </Button>
            <WriteGate closed={retired}>
              {ops && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => void drafting()}
                    disabled={busy !== null || dirty}
                    title="Draft the unwritten sections from the latest calculation and the research on file. Sections you have written are left alone."
                  >
                    {busy === 'draft' ? 'Drafting…' : 'Draft with AI'}
                  </Button>
                  <Button variant="secondary" onClick={() => void render()} disabled={busy !== null || dirty}>
                    {busy === 'render' ? 'Rendering…' : 'Render PDF'}
                  </Button>
                  <Button
                    onClick={() => void save()}
                    disabled={busy !== null || !dirty}
                    title={
                      conflictedWith === null
                        ? undefined
                        : `Someone else saved v${conflictedWith} while you were editing. Saving now appends your draft on top of theirs — read v${conflictedWith} in the version history first.`
                    }
                  >
                    {busy === 'save'
                      ? 'Saving…'
                      : conflictedWith === null
                        ? 'Save (new version)'
                        : `Save over v${conflictedWith}`}
                  </Button>
                </>
              )}
            </WriteGate>
          </div>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}
        {notice && (
          <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
            {notice}
          </div>
        )}
        {ops && dirty && (
          <p className="text-xs font-medium text-amber-700">
            Unsaved changes — render is disabled until you save.
          </p>
        )}

        {/* §4.5 — plain-English summary; renders only when one exists. */}
        <ExplanationCard valuationId={valuation.id} />

        <WriteGate closed={retired}>
          {ops ? (
            <TextInput
              value={content.title}
              onChange={(e) => {
                const title = e.target.value;
                setContent((cur) => (cur ? { ...cur, title } : cur));
                setDirty(true);
              }}
              className="font-display !text-lg font-semibold"
              aria-label="Report title"
            />
          ) : (
            <h2 className="font-display text-xl font-semibold text-ink-900">{content.title}</h2>
          )}

          {shown.map((section) => {
            const index = content.sections.indexOf(section);
            const isHidden = section.hidden === true;
            const number = numberOf(section);
            return (
              <section
                key={section.key}
                id={sectionDomId(section.key)}
                // Anchored navigation lands the heading under the sticky page
                // chrome rather than behind it.
                className={`scroll-mt-6 rounded-lg border p-5 shadow-card ${
                  isHidden ? 'border-dashed border-ink-300 bg-paper-100' : 'border-paper-300 bg-surface'
                }`}
              >
                {ops ? (
                  <>
                    <div className="mb-3 flex items-start gap-3">
                      {/* The number the chapter will carry in the PDF — an omitted
                        one takes none, which is the quickest read on what the
                        omit button just did. */}
                      <span
                        className="tnum mt-2 w-6 shrink-0 text-right text-sm font-semibold text-ink-400"
                        aria-hidden
                      >
                        {number ?? '—'}
                      </span>
                      <TextInput
                        value={section.heading}
                        onChange={(e) => updateSection(index, { heading: e.target.value })}
                        className="!text-base font-semibold"
                        aria-label={`Heading for section ${index + 1}`}
                      />
                      <Button
                        variant="secondary"
                        onClick={() => updateSection(index, { hidden: !isHidden })}
                        aria-pressed={isHidden}
                        title={
                          isHidden
                            ? 'Include this chapter in the rendered report. The text you wrote is still here.'
                            : 'Leave this chapter out of the rendered report. The text is kept, not deleted, and the version history still shows it.'
                        }
                      >
                        {isHidden ? 'Include' : 'Omit'}
                      </Button>
                    </div>
                    {isHidden && (
                      <p className="mb-3 text-xs font-medium text-ink-500">
                        Omitted from the rendered report. The text below is kept and will come back if you
                        include the chapter again.
                      </p>
                    )}
                    <RichTextEditor
                      value={section.html}
                      onChange={(html) => updateSection(index, { html })}
                      disabled={retired}
                    />
                  </>
                ) : (
                  <>
                    <h3 className="mb-3 font-display text-base font-semibold text-ink-900">
                      {numberOf(section)}. {section.heading}
                    </h3>
                    <div
                      className="report-editor text-sm leading-relaxed text-ink-800"
                      dangerouslySetInnerHTML={{ __html: sanitizeHtml(section.html) }}
                    />
                  </>
                )}
              </section>
            );
          })}
        </WriteGate>
      </div>

      {/* The sidebar is no longer ops-only: the outline is the reader's table of
          contents as much as the analyst's, and a client reading a shared draft
          has the same twenty-seven chapters to get through. */}
      <aside className="space-y-8 lg:sticky lg:top-6 lg:self-start">
        <ReportOutline sections={shown} numberOf={numberOf} />

        {ops && (
          <div>
            <h2 className="overline mb-4 text-ink-400">Version history</h2>
            {versions.length === 0 && <p className="text-sm text-ink-400">No versions yet.</p>}
            <ol className="space-y-3">
              {versions.map((v) => (
                <li
                  key={v.id}
                  className={`rounded-md border px-3.5 py-2.5 text-sm ${
                    v.version === report.current_version
                      ? 'border-bond-200 bg-bond-50'
                      : 'border-paper-300 bg-surface'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-ink-800">
                      v{v.version}
                      {v.version === report.current_version && (
                        <span className="ml-1.5 text-xs font-medium text-bond-700">current</span>
                      )}
                    </span>
                    {v.version !== report.current_version && (
                      <WriteGate closed={retired}>
                        <Button
                          variant="ghost"
                          className="!px-2 !py-0.5 !text-xs"
                          onClick={() => void restore(v.version)}
                          disabled={busy !== null}
                        >
                          Restore
                        </Button>
                      </WriteGate>
                    )}
                  </div>
                  <div className="tnum mt-0.5 text-xs text-ink-400">{formatDateTime(v.created_at)}</div>
                  {v.has_pdf && <div className="mt-0.5 text-xs text-bond-700">PDF rendered</div>}
                </li>
              ))}
            </ol>
          </div>
        )}
      </aside>
    </div>
  );
}
