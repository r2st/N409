import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { api, apiDownload, apiUpload, describeActionFailure, describeLoadFailure, describeRequestFailure } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_KINDS,
  formatBytes,
  type DocumentKind,
  type ValuationDocument,
} from '../../lib/pipeline';
import {
  Button,
  EmptyState,
  ErrorNote,
  ListTruncationNote,
  LoadingBlock,
  Select,
  Skeleton,
  SkeletonDividedList,
} from '../ui';

/**
 * Mirrors MAX_DOCUMENT_BYTES on the upload route.
 *
 * Checked here as well as there because the server can only refuse a file it
 * has already received: a client on a slow uplink otherwise spends minutes
 * pushing a file that was never going to be accepted, and the batch it was part
 * of is held up behind it. The server remains the authority — this only saves
 * the round trip.
 */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * A file that never left the browser, phrased like the server's own refusal.
 *
 * Exported because this is not the only screen that posts to
 * `POST /valuations/:id/documents`: the onboarding funnel's step 3 does too,
 * and it is the door where the check matters most — a first-time client on a
 * home uplink, sending the scanned incorporation documents the wizard asks
 * for. That door had no local check at all, so the two screens onto one
 * endpoint disagreed about what could be sent.
 */
export function localUploadRejection(file: File): string | null {
  if (file.size === 0) return 'the file is empty';
  if (file.size > MAX_DOCUMENT_BYTES)
    return `it is ${formatBytes(file.size)}, over the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit`;
  return null;
}

/** Per-valuation document intake: drag-and-drop upload, list by kind, download, delete. */
export function DocumentsPanel({
  valuationId,
  canReview = false,
  onReviewed,
  canUpload = true,
}: {
  valuationId: string;
  /** Ops only — the review mark is an analyst's own working state (§4.6). */
  canReview?: boolean;
  /** Lets the workspace refresh the header chip the mark just changed. */
  onReviewed?: () => void | Promise<void>;
  /**
   * Whether new files may be added. False for a retired engagement, whose
   * upload route answers 409 — and answers it after the whole file has been
   * transferred, which is why this one is closed in the browser and not left
   * to the server. Defaults true so the prop is opt-in for the one caller that
   * has a reason to close it; the list, the downloads and the review marks are
   * untouched, because reading what is already there is not writing.
   */
  canUpload?: boolean;
}) {
  const [documents, setDocuments] = useState<ValuationDocument[] | null>(null);
  /** True when the engagement holds more files than this page carries. */
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** One line per file that did not upload, so a batch names its own failures. */
  const [rejected, setRejected] = useState<string[]>([]);
  const [kind, setKind] = useState<DocumentKind>('other');
  /** Which file of how many is in flight, or null when nothing is uploading. */
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = progress !== null;

  const load = useCallback(async () => {
    try {
      const { documents: docs, truncated: more } = await api<{
        documents: ValuationDocument[];
        truncated: boolean;
      }>(`/valuations/${valuationId}/documents`);
      setDocuments(docs);
      setTruncated(more);
    } catch (err) {
      setError(describeLoadFailure(err, 'Could not load documents.'));
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Upload a batch, one file at a time, finishing the batch whatever happens.
   *
   * The loop used to abort on the first rejection and report "Upload failed."
   * — so dragging in a folder of eight files where the second was over the
   * limit uploaded one, silently skipped six, and named none of them. Dropping
   * a batch is the normal way to use this panel, and one bad file in it is the
   * normal reason a batch goes wrong, so a failure has to say which file and
   * leave the others alone.
   */
  const upload = async (files: FileList | File[]) => {
    const batch = Array.from(files);
    if (batch.length === 0) return;
    setError(null);
    setRejected([]);

    const failures: string[] = [];
    let uploaded = 0;
    for (const [index, file] of batch.entries()) {
      setProgress({ done: index, total: batch.length, name: file.name });

      const localReason = localUploadRejection(file);
      if (localReason !== null) {
        failures.push(`${file.name} — ${localReason}`);
        continue;
      }
      try {
        const form = new FormData();
        form.append('kind', kind);
        form.append('file', file);
        await apiUpload(`/valuations/${valuationId}/documents`, form);
        uploaded += 1;
      } catch (err) {
        // The filename is already the subject of the sentence, so the rest of
        // it is purely why — including for the detail-less bodies, where
        // `err.message` was the reason phrase and this row read "notes.pdf —
        // Internal Server Error".
        failures.push(`${file.name} — ${describeRequestFailure(err)}`);
      }
    }
    setProgress(null);
    setRejected(failures);
    // Only re-read when something actually landed: a batch that failed outright
    // has not changed the list, and refetching it just makes the failure blink.
    if (uploaded > 0) await load();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) void upload(e.dataTransfer.files);
    else {
      // Dropping a folder, a URL or a selection yields no files. Saying so
      // beats the silence that used to look like the drop simply not landing.
      setRejected(['Nothing to upload — drop files rather than a folder.']);
    }
  };

  const remove = async (doc: ValuationDocument) => {
    if (!window.confirm(`Remove "${doc.filename}"?`)) return;
    try {
      await api(`/valuations/${valuationId}/documents/${doc.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not delete the document.'));
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
      setError(describeActionFailure(err, 'Could not update the review mark.'));
      await load();
    }
  };

  const download = async (doc: ValuationDocument) => {
    // fetch → blob URL via apiDownload; a plain <a href> can't carry auth. The
    // httpOnly session cookie authenticates same-origin and apiDownload adds
    // the bearer when a token is in memory this tab (audit F-2). This used to
    // be a hand-rolled copy that skipped appending the anchor to the document
    // before clicking it — which Firefox ignores — and revoked the blob URL in
    // the same tick, racing the download it had just started.
    try {
      await apiDownload(`/valuations/${valuationId}/documents/${doc.id}/download`, doc.filename);
    } catch (err) {
      setError(describeActionFailure(err, 'Download failed.'));
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

      {/* Named per file, because "some of that batch did not upload" is only
          actionable if you know which and why. */}
      {rejected.length > 0 && (
        <ErrorNote>
          <span className="font-semibold">
            {rejected.length === 1 ? '1 file was not uploaded' : `${rejected.length} files were not uploaded`}
          </span>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {/* Index-keyed: a batch can hold two files of the same name from
                different folders, so the line is not a unique key. The list is
                replaced wholesale per batch, never reordered. */}
            {rejected.map((line, i) => (
              <li key={`${i}:${line}`}>{line}</li>
            ))}
          </ul>
        </ErrorNote>
      )}

      {canUpload && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1.5 block text-[0.8rem] font-semibold text-ink-700">Document type</span>
            <Select
              value={kind}
              disabled={busy}
              onChange={(e) => setKind(e.target.value as DocumentKind)}
              className="w-56"
            >
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
            onChange={(e) => {
              const picked = e.target.files;
              // Clearing the input is what lets the same file be picked twice.
              // A file rejected for its size is exactly the one a user fixes and
              // re-selects, and without this the second attempt fires no change
              // event at all — the panel simply ignores the click.
              e.target.value = '';
              if (picked) void upload(picked);
            }}
          />
        </div>
      )}

      {canUpload && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          aria-busy={busy}
          className={`rounded-lg border-2 border-dashed px-6 py-8 text-center text-sm transition-colors ${
            dragging ? 'border-bond-500 bg-bond-50 text-bond-700' : 'border-ink-200 bg-paper-50 text-ink-400'
          }`}
        >
          {progress ? (
            // Which file, and how far through — a batch of large files otherwise
            // shows one unchanging "Uploading…" for minutes and reads as hung.
            <span role="status">
              Uploading {progress.done + 1} of {progress.total} —{' '}
              <span className="font-semibold">{progress.name}</span>
            </span>
          ) : (
            <>
              Drag &amp; drop files here — they upload as{' '}
              <span className="font-semibold">{DOCUMENT_KIND_LABELS[kind]}</span> (max{' '}
              {MAX_DOCUMENT_BYTES / (1024 * 1024)} MB each)
            </>
          )}
        </div>
      )}

      {documents && documents.length === 0 && (
        <EmptyState title="No documents yet">
          {canUpload
            ? 'Upload the cap table, financials and projections to unlock AI extraction.'
            : /* The live copy is an instruction, and instructing someone to
                 upload to an engagement that refuses uploads is the empty
                 state lying about what it is. */
              'Nothing was filed against this engagement before it was retired.'}
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
              {/* A list of ten documents otherwise offers ten buttons named
                  "Download" and ten named "Delete", which is what a screen
                  reader's element list shows — the filename is the only thing
                  that tells them apart. */}
              <Button
                variant="ghost"
                aria-label={`Download ${doc.filename}`}
                onClick={() => void download(doc)}
              >
                Download
              </Button>
              <Button variant="danger" aria-label={`Delete ${doc.filename}`} onClick={() => void remove(doc)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* The intake checklist beside this list counts every file in SQL, so a
          short page here does not make a bucket read as empty — but a file
          somebody uploaded and cannot find would still read as a file that
          never arrived. */}
      <ListTruncationNote
        truncated={truncated}
        shown={documents?.length ?? 0}
        noun="documents"
        hint="filter by category to reach the rest"
      />
    </div>
  );
}
