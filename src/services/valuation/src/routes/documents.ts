import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { DOCUMENT_KINDS, type DocumentKind } from '../domain/pipeline.js';
import {
  DOCUMENT_CATEGORIES,
  resolveDocumentFiling,
  summarizeCategories,
  type DocumentCategory,
} from '../domain/documentCategories.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import {
  createDocument,
  deleteDocument,
  findDocumentById,
  listDocuments,
  setDocumentReviewed,
  type DocumentRow,
} from '../repos/documents.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { maybeStartAutoPipeline, type AutoPipelineDeps } from '../pipeline/autoPipeline.js';
import { checkUploadType } from '../documents/fileType.js';
import { scanUpload, UploadRejected, type ScanPolicy } from '../documents/virusScan.js';
import { decodeFromStorage, encodeForStorage } from '../storage/documentEncryption.js';
import { bufferUpload, UPLOAD_FIELD_LIMITS } from './uploadLimits.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { forbidden } from '../domain/accessProblem.js';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

async function loadAuthorizedValuation(
  pool: pg.Pool,
  principal: Principal,
  id: string,
): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (
    !valuation ||
    !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
  ) {
    throw problems.notFound();
  }
  return valuation;
}

/**
 * The characters a filename may not contain, wherever the name came from:
 * path separators, the drive colon, the quote that delimits a header's
 * quoted-string, and the backslash that escapes it. Replaced with '_' and
 * collapsed, so a name stays recognizable rather than losing its shape.
 *
 * Written as a loop over a set rather than a regex to avoid a control-char
 * regex literal.
 */
function scrubFilename(name: string): string {
  const bad = new Set(['\\', '/', ':', '"']);
  let cleaned = '';
  let prevReplaced = false;
  for (const ch of name) {
    const isBad = bad.has(ch) || ch.charCodeAt(0) < 0x20;
    if (isBad) {
      if (!prevReplaced) cleaned += '_';
      prevReplaced = true;
    } else {
      cleaned += ch;
      prevReplaced = false;
    }
  }
  return cleaned.trim();
}

/**
 * Strip directories and control characters; keep the name recognizable.
 *
 * `basename` first, because the name arrives from a browser that may send a
 * whole path — `C:\Users\me\cap table.xlsx` from an old Windows client — and
 * `cap table.xlsx` is a better answer than `C__Users_me_cap table.xlsx`.
 */
export function safeFilename(name: string): string {
  return (scrubFilename(path.basename(name)) || 'upload').slice(0, 200);
}

/**
 * RFC 6266 Content-Disposition header value. Provides an ASCII-safe
 * ``filename`` for legacy clients and ``filename*`` with UTF-8 percent-
 * encoding for modern ones that understand RFC 5987.
 *
 * Scrubbed first, which it was not. Two of the callers pass a name that has
 * already been through {@link safeFilename} — but `report.pdf` builds its
 * filename out of `valuation.company_name`, which is `z.string().min(1).max(300)`
 * and nothing else, and that reached the header raw:
 *
 *   "Acme\"            → filename="Acme\"; filename*=UTF-8''Acme%5C
 *   "../../etc/passwd" → filename="../../etc/passwd"
 *
 * The first is the one that matters. A trailing backslash is a quoted-pair
 * escaping the closing quote, so the quoted-string never terminates and a
 * strict parser reads the rest of the header — the `filename*` parameter
 * included — as part of the name. The second is what RFC 6266 §4.3 says a
 * sender must not do; recipients are told to strip path information precisely
 * because senders like this one did not.
 *
 * There was a third, quieter one: the two forms disagreed. The ASCII fallback
 * *dropped* quotes while the ext-value percent-encoded them, so a client
 * preferring `filename` and a client preferring `filename*` saved the same
 * response under different names. Both are now derived from one scrubbed
 * string, so the ASCII form differs from the UTF-8 one only where it must —
 * in the characters ASCII cannot spell.
 *
 * `basename` is deliberately not applied here: this name is a display name
 * built by the server, not a path sent by a client, and a company called
 * "Acme/Beta" should keep both halves rather than lose the first.
 */
export function contentDisposition(
  name: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const safe = (scrubFilename(name) || 'download').slice(0, 200);
  // ASCII-only fallback: the quote and backslash are already gone, so what is
  // left is the characters ASCII has no spelling for.
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_');
  // RFC 5987 encoding: percent-encode everything outside unreserved chars.
  const encoded = [...safe]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (
        (code >= 0x30 && code <= 0x39) || // 0-9
        (code >= 0x41 && code <= 0x5a) || // A-Z
        (code >= 0x61 && code <= 0x7a) || // a-z
        ch === '-' ||
        ch === '.' ||
        ch === '_' ||
        ch === '~'
      )
        return ch;
      return [...new TextEncoder().encode(ch)]
        .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
        .join('');
    })
    .join('');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Turns a virus-scan rejection into the same 422 an upload gets for failing the
 * type check — it is the caller's file that is the problem, not the server's
 * state. Shared by both upload routes so the two report identically.
 *
 * The signature is deliberately included: it tells an analyst whose own file
 * was flagged that the answer is "clean your machine", not "retry", and it is
 * the scanner's public name for a public sample, not a detail about us.
 */
export function rethrowRejectedUpload(filename: string) {
  return (err: unknown): never => {
    if (err instanceof UploadRejected) {
      throw problems.unprocessable(`Rejected upload: ${err.reason}`, {
        filename,
        scan: err.verdict.status,
      });
    }
    throw err;
  };
}

/**
 * Writes the blob to disk and records the document row + event. Shared by the
 * session upload route below and the partner API (improvement 6).
 */
export async function storeDocument(
  pool: pg.Pool,
  documentsDir: string,
  valuation: ValuationRow,
  input: {
    kind: DocumentKind;
    /** Intake bucket (0105); derived from the kind when the caller omits it. */
    category?: DocumentCategory;
    filename: string;
    contentType: string;
    buffer: Buffer;
  },
  actor: EventActor,
  uploadedBy: string,
  options: { scan?: ScanPolicy } = {},
): Promise<DocumentRow> {
  const filename = safeFilename(input.filename);

  // Before anything touches disk. Placed here rather than in the two upload
  // routes so a third way to upload a file cannot skip it — see virusScan.ts.
  // `UploadRejected` is translated to a 422 by the callers; a scan that simply
  // is not configured returns clean and costs nothing.
  if (options.scan) await scanUpload(input.buffer, options.scan, { filename });

  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const dir = path.join(documentsDir, valuation.id);
  await mkdir(dir, { recursive: true });

  // Storage path is <valuationId>/<sha-prefix>__<filename>; identical content
  // re-uploaded under the same name simply overwrites the same blob.
  // sha256 is over the plaintext (stable dedup + integrity); the bytes on disk
  // are encrypted when DOCUMENTS_ENCRYPTION_KEY is set (audit B-5 P1).
  const storageRel = path.join(valuation.id, `${sha256.slice(0, 16)}__${filename}`);
  await writeFile(path.join(documentsDir, storageRel), encodeForStorage(input.buffer));

  return createDocument(
    pool,
    {
      valuationId: valuation.id,
      kind: input.kind,
      category: input.category,
      filename,
      contentType: input.contentType || 'application/octet-stream',
      sizeBytes: input.buffer.length,
      sha256,
      storagePath: storageRel,
      uploadedBy,
    },
    actor,
  );
}

/**
 * A blob that will not read is a failure of the storage, not of the request.
 *
 * The missing-file case has always been handled — a 404 saying so. The two
 * *unreadable* cases were not, and they are the ones that happen without
 * anybody deleting anything:
 *
 *   * `decodeFromStorage` is AES-GCM, so a truncated write (a full disk, a box
 *     that lost power between `writeFile` and its flush), a flipped bit, or a
 *     restore from a snapshot taken mid-write all fail the authentication tag;
 *   * a deployment whose `DOCUMENTS_ENCRYPTION_KEY` was rotated without
 *     `_PREVIOUS`, or lost, fails every encrypted blob at once.
 *
 * Both threw a bare `Error` from outside the `try` above, so both reached the
 * client as `500 urn:n409:problem:internal` — a body that carries no `detail`
 * by design and left the analyst with a Download button that does nothing and
 * says nothing. The second one is the worse of the two, because it is not one
 * file: it is every file, and the only symptom was a 500.
 *
 * The integrity check is the other half. `documents.sha256` is taken over the
 * plaintext at upload and has never been read since; without it, corruption of
 * an *unencrypted* deployment's blob has no detector at all — the bytes come
 * back changed, under the right filename and content type, and are served as
 * the document. A hash mismatch is the same answer as a decryption failure,
 * because they are the same event seen through two storage configurations.
 *
 * Logged with `alert: true`: a document this platform accepted and can no
 * longer return is a data-loss event, and the file is not coming back on its
 * own. The client is told what happened and told to re-upload, which is the
 * only thing that fixes it.
 */
export function readStoredBlob(
  doc: Pick<DocumentRow, 'id' | 'sha256'>,
  stored: Buffer,
  log?: { error: (obj: Record<string, unknown>, msg: string) => void },
): Buffer {
  let plain: Buffer;
  try {
    // Decrypt in memory (blobs are ≤25 MB) — GCM can't be streamed off disk.
    plain = decodeFromStorage(stored);
  } catch (err) {
    log?.error({ err, documentId: doc.id, alert: true }, 'stored document could not be decrypted');
    throw documentUnreadable();
  }
  // `sha256` is nullable on rows written before the column existed; a document
  // with nothing to compare against is served, not refused.
  if (doc.sha256) {
    const actual = createHash('sha256').update(plain).digest('hex');
    if (actual !== doc.sha256) {
      log?.error(
        { documentId: doc.id, expected: doc.sha256, actual, alert: true },
        'stored document failed its integrity check',
      );
      throw documentUnreadable();
    }
  }
  return plain;
}

const documentUnreadable = () =>
  new ApiProblem({
    status: 500,
    title: 'Document Unreadable',
    type: 'urn:n409:problem:document-unreadable',
    detail:
      'This file is stored but cannot be read back — it is damaged or was written under an encryption ' +
      'key this deployment no longer has. Re-upload it; retrying the download will not help.',
  });

export function registerDocumentRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; documentsDir: string; autoPipeline?: AutoPipelineDeps; scan?: ScanPolicy },
): void {
  app.post('/api/v1/valuations/:id/documents', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
    refuseIfRetired(valuation, 'accepting documents');

    // Field caps repeated here rather than left to the plugin registration:
    // per-call `limits` and plugin `limits` are merged by @fastify/multipart,
    // but the protection belongs where the upload is, not one file away.
    const file = await req.file({
      limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, ...UPLOAD_FIELD_LIMITS },
    });
    if (!file) throw problems.badRequest('Expected a multipart file field named "file"');

    // Either axis, or both: an API caller thinks in kinds, the person clicking
    // "Monthly income statements" in the intake UI has never heard of one.
    // A contradictory pair is refused rather than silently corrected — see
    // resolveDocumentFiling.
    const filing = resolveDocumentFiling({
      kind: (file.fields.kind as { value?: string } | undefined)?.value ?? null,
      category: (file.fields.category as { value?: string } | undefined)?.value ?? null,
    });
    if ('error' in filing) {
      throw problems.unprocessable(filing.error, {
        allowed_kinds: DOCUMENT_KINDS,
        allowed_categories: DOCUMENT_CATEGORIES,
      });
    }
    const { kind, category } = filing;

    const buffer = await bufferUpload(file, MAX_DOCUMENT_BYTES);
    if (buffer.length === 0) throw problems.unprocessable('Uploaded file is empty');

    // Confirm the bytes match the declared type before the file can feed the AI
    // pipeline or be served back (audit B-1 P2).
    const typeCheck = checkUploadType(file.filename, buffer);
    if (!typeCheck.ok) {
      throw problems.unprocessable(`Rejected upload: ${typeCheck.reason}`, {
        filename: file.filename,
        sniffed: typeCheck.sniffed,
      });
    }

    const document = await storeDocument(
      deps.pool,
      deps.documentsDir,
      valuation,
      { kind, category, filename: file.filename, contentType: file.mimetype, buffer },
      actorFor(principal),
      principal.id,
      { scan: deps.scan },
    ).catch(rethrowRejectedUpload(file.filename));

    // Improvement 2 — auto-pipeline: an extractable upload kicks off
    // extraction → param fill → draft calculation without blocking the
    // response; the run row (if any) lets the client poll immediately.
    const pipelineRun = deps.autoPipeline
      ? await maybeStartAutoPipeline(deps.autoPipeline, {
          valuation,
          document,
          triggeredBy: principal.id,
        })
      : null;
    return reply.status(201).send({ document, pipeline_run: pipelineRun });
  });

  app.get('/api/v1/valuations/:id/documents', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
    const parsed = z.object({ category: z.enum(DOCUMENT_CATEGORIES).optional() }).safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    return { documents: await listDocuments(deps.pool, valuation.id, parsed.data) };
  });

  /**
   * The intake checklist. All thirteen buckets, always, in a fixed order — an
   * empty bucket is the thing the client needs to see, so filtering to the
   * ones with uploads in them would hide exactly the useful half.
   */
  app.get('/api/v1/valuations/:id/documents/categories', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
    const documents = await listDocuments(deps.pool, valuation.id);
    const categories = summarizeCategories(documents);
    return {
      categories,
      // What still blocks the engagement, so a client does not have to scan
      // six rows for the one that matters.
      missing_required: categories.filter((c) => !c.satisfied).map((c) => c.key),
    };
  });

  app.get(
    '/api/v1/valuations/:id/documents/:documentId/download',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, documentId } = req.params as { id: string; documentId: string };
      const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
      const doc = await loadDocument(deps.pool, valuation.id, documentId);

      const abs = path.join(deps.documentsDir, doc.storage_path);
      let stored: Buffer;
      try {
        stored = await readFile(abs);
      } catch {
        throw problems.notFound('Stored file is missing');
      }
      const plain = readStoredBlob(doc, stored, req.log);
      // nosniff so a stored text/html blob can't be sniffed and rendered
      // inline (audit B-1 P1); attachment already forces a download.
      return reply
        .header('content-type', doc.content_type)
        .header('content-disposition', contentDisposition(doc.filename))
        .header('x-content-type-options', 'nosniff')
        .send(plain);
    },
  );

  /**
   * Clear a document off the "pending files" counter, or put it back (§4.6).
   *
   * Ops-only, because the counter is an analyst's own working state: it says
   * "I have taken this file into account", and a client marking their own
   * upload reviewed would empty the queue that exists to be worked through.
   *
   * A toggle rather than two endpoints — the mistaken click is the common case,
   * and a one-way action turns it into a wrong number nobody can fix.
   */
  app.post(
    '/api/v1/valuations/:id/documents/:documentId/review',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id, documentId } = req.params as { id: string; documentId: string };
      const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
      refuseIfRetired(valuation, 'accepting documents');
      if (!isOps(principal)) throw problems.forbidden('Marking a document reviewed is operations-only');

      const parsed = z.object({ reviewed: z.boolean().default(true) }).safeParse(req.body ?? {});
      if (!parsed.success) throw invalidBody('Invalid body', parsed.error);

      await loadDocument(deps.pool, valuation.id, documentId);
      const document = await setDocumentReviewed(deps.pool, documentId, parsed.data.reviewed, principal.id);
      if (!document) throw problems.notFound();
      return { document };
    },
  );

  app.delete(
    '/api/v1/valuations/:id/documents/:documentId',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, documentId } = req.params as { id: string; documentId: string };
      const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
      const doc = await loadDocument(deps.pool, valuation.id, documentId);

      // Ops can prune anything; everyone else only what they uploaded.
      if (!isOps(principal) && doc.uploaded_by !== principal.id) throw forbidden('Deleting this document', 'own-record');
      await deleteDocument(deps.pool, doc, actorFor(principal));
      return reply.status(204).send();
    },
  );

  async function loadDocument(pool: pg.Pool, valuationId: string, documentId: string): Promise<DocumentRow> {
    if (!isUlid(documentId)) throw problems.notFound();
    const doc = await findDocumentById(pool, documentId);
    if (!doc || doc.valuation_id !== valuationId) throw problems.notFound();
    return doc;
  }
}
