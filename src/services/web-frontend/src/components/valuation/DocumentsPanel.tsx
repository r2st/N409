import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { api, apiUpload, ApiError, getToken } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_KINDS,
  formatBytes,
  type DocumentKind,
  type ValuationDocument,
} from '../../lib/pipeline';
import { Button, EmptyState, ErrorNote, LoadingBlock, Select, Skeleton, SkeletonDividedList } from '../ui';

/** Per-valuation document intake: drag-and-drop upload, list by kind, download, delete. */
export function DocumentsPanel({
  valuationId,
  canReview = false,
  onReviewed,
}: {
  valuationId: string;
  /** Ops only — the review mark is an analyst's own working state (§4.6). */
  canReview?: boolean;
  /** Lets the workspace refresh the header chip the mark just changed. */
  onReviewed?: () => void | Promise<void>;
}) {
  const [documents, setDocuments] = useState<ValuationDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<DocumentKind>('other');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const { documents: docs } = await api<{ documents: ValuationDocument[] }>(
        `/valuations/${valuationId}/documents`,
      );
      setDocuments(docs);
    } catch {
      setError('Could not load documents.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (files: FileList | File[]) => {
    setError(null);
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('kind', kind);
        form.append('file', file);
        await apiUpload(`/valuations/${valuationId}/documents`, form);
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) void upload(e.dataTransfer.files);
  };

  const remove = async (doc: ValuationDocument) => {
    if (!window.confirm(`Remove "${doc.filename}"?`)) return;
    try {
      await api(`/valuations/${valuationId}/documents/${doc.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the document.');
    }
  };

  const setReviewed = async (doc: ValuationDocument, reviewed: boolean) => {
    // Optimistic: the mark is a one-field toggle with no downstream effect, and
    // waiting a round trip to grey out a row makes clearing a stack of files
    // feel like it is failing.
    setDocuments((docs) =>
      docs
        ? docs.map((d) =>
            d.id === doc.id ? { ...d, reviewed_at: reviewed ? new Date().toISOString() : null } : d,
          )
        : docs,
    );
    try {
      await api(`/valuations/${valuationId}/documents/${doc.id}/review`, {
        method: 'POST',
        body: { reviewed },
      });
      await onReviewed?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the review mark.');
      await load();
    }
  };

  const download = async (doc: ValuationDocument) => {
    // fetch → blob URL; a plain <a href> can't carry auth. The httpOnly session
    // cookie authenticates same-origin; add the bearer only when a token is in
    // memory this tab (audit F-2).
    try {
      const token = getToken();
      const res = await fetch(`/api/v1/valuations/${valuationId}/documents/${doc.id}/download`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Download failed.');
    }
  };

  // Controls, dropzone and the file list — all fixed; only the rows are unknown.
  if (!documents && !error)
    return (
      <LoadingBlock label="Loading documents…" className="space-y-5">
        <div className="flex flex-wrap items-end gap-3" aria-hidden>
          <Skeleton className="h-[62px] w-56" />
          <Skeleton className="h-[38px] w-32" />
        </div>
        <Skeleton className="h-[90px] w-full rounded-lg" />
        <SkeletonDividedList rows={4} lines={2} badges={1} />
      </LoadingBlock>
    );

  return (
    <div className="space-y-5">
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1.5 block text-[0.8rem] font-semibold text-ink-700">Document type</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)} className="w-56">
            {DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {DOCUMENT_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </label>
        <Button variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
          {busy ? 'Uploading…' : 'Choose files'}
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => e.target.files && void upload(e.target.files)}
        />
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-lg border-2 border-dashed px-6 py-8 text-center text-sm transition-colors ${
          dragging ? 'border-bond-500 bg-bond-50 text-bond-700' : 'border-ink-200 bg-paper-50 text-ink-400'
        }`}
      >
        Drag &amp; drop files here — they upload as{' '}
        <span className="font-semibold">{DOCUMENT_KIND_LABELS[kind]}</span> (max 25 MB each)
      </div>

      {documents && documents.length === 0 && (
        <EmptyState title="No documents yet">
          Upload the cap table, financials and projections to unlock AI extraction.
        </EmptyState>
      )}

      {documents && documents.length > 0 && (
        <ul className="divide-y divide-paper-300 rounded-lg border border-paper-300 bg-surface shadow-card">
          {documents.map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-ink-900">{doc.filename}</span>
                  {doc.reviewed_at && (
                    <span className="rounded-full bg-paper-300 px-2 py-0.5 text-[0.65rem] font-semibold text-ink-500">
                      reviewed
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-ink-400">
                  {DOCUMENT_KIND_LABELS[doc.kind] ?? doc.kind} · {formatBytes(doc.size_bytes)} ·{' '}
                  {formatDateTime(doc.created_at)}
                </div>
              </div>
              {canReview && (
                <Button
                  variant="ghost"
                  aria-label={doc.reviewed_at ? `Reopen ${doc.filename}` : `Mark ${doc.filename} reviewed`}
                  onClick={() => void setReviewed(doc, !doc.reviewed_at)}
                >
                  {doc.reviewed_at ? 'Reopen' : 'Mark reviewed'}
                </Button>
              )}
              <Button variant="ghost" onClick={() => void download(doc)}>
                Download
              </Button>
              <Button variant="danger" onClick={() => void remove(doc)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
