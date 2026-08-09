import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken } from '../../lib/api';
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
import { useWorkspace } from './ValuationWorkspace';
import { RichTextEditor } from '../../components/RichTextEditor';
import { ExplanationCard } from '../../components/valuation/ExplanationCard';
import { Button, EmptyState, ErrorNote, Spinner, TextInput } from '../../components/ui';

const STATUS_LABELS: Record<Report['status'], string> = {
  draft: 'Draft',
  accepted: 'Accepted',
  changes: 'Changes requested',
  published: 'Published',
};

/**
 * Report workspace: WYSIWYG section editor (ops), version history with
 * restore, PDF render + download. Clients get a read-only view once the
 * report is drafted.
 */
export function ReportTab() {
  const { valuation } = useWorkspace();
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

  const load = useCallback(async () => {
    try {
      const res = await api<{ report: Report; version: { version: number; content: ReportContent } | null }>(
        `/valuations/${valuation.id}/report`,
      );
      setReport(res.report);
      setContent(res.version?.content ?? null);
      setDirty(false);
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
      const res = await api<{ report: Report; version: { version: number; content: ReportContent } }>(
        `/valuations/${valuation.id}/report`,
        { method: 'PUT', body: { content } },
      );
      setReport(res.report);
      setContent(res.version.content);
      setDirty(false);
      setNotice(`Saved as version ${res.version.version}.`);
      const { versions: v } = await api<{ versions: ReportVersionSummary[] }>(
        `/valuations/${valuation.id}/report/versions`,
      );
      setVersions(v);
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
        `${valuation.company_name.replace(/[^\w.-]+/g, '_')}_report_v${report.current_version}.pdf`,
        getToken(),
      ),
    );

  const restore = (version: number) =>
    run('restore', async () => {
      await api(`/valuations/${valuation.id}/report/revert`, { method: 'POST', body: { version } });
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
  const numberOf = (section: ReportSection) => visible.indexOf(section) + 1;
  const shown = ops ? content.sections : visible;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-6">
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
                <Button onClick={() => void save()} disabled={busy !== null || !dirty}>
                  {busy === 'save' ? 'Saving…' : 'Save (new version)'}
                </Button>
              </>
            )}
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
          return (
            <section
              key={section.key}
              className={`rounded-lg border p-5 shadow-card ${
                isHidden ? 'border-dashed border-ink-300 bg-paper-100' : 'border-paper-300 bg-surface'
              }`}
            >
              {ops ? (
                <>
                  <div className="mb-3 flex items-start gap-3">
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
                      Omitted from the rendered report. The text below is kept and will come back if
                      you include the chapter again.
                    </p>
                  )}
                  <RichTextEditor
                    value={section.html}
                    onChange={(html) => updateSection(index, { html })}
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
      </div>

      {ops && (
        <aside>
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
                    <Button
                      variant="ghost"
                      className="!px-2 !py-0.5 !text-xs"
                      onClick={() => void restore(v.version)}
                      disabled={busy !== null}
                    >
                      Restore
                    </Button>
                  )}
                </div>
                <div className="tnum mt-0.5 text-xs text-ink-400">{formatDateTime(v.created_at)}</div>
                {v.has_pdf && <div className="mt-0.5 text-xs text-bond-700">PDF rendered</div>}
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
  );
}
