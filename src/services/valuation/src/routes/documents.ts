import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { access, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { DOCUMENT_KINDS, PIPELINE_EVENT_TYPES, type DocumentKind } from '../domain/pipeline.js';
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
  documentPathInUse,
  findDocumentById,
  documentCoverage,
  listDocuments,
  setDocumentReviewed,
  type DocumentRow,
} from '../repos/documents.js';
import { requirePrincipal } from '../plugins/auth.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { withTransaction } from '../db/pool.js';
import { maybeStartAutoPipeline, type AutoPipelineDeps } from '../pipeline/autoPipeline.js';
import { checkUploadType } from '../documents/fileType.js';
import { safeFilename, scrubFilename } from '../documents/filename.js';
import { normalizeMediaType } from '../documents/mediaType.js';
import { scanUpload, UploadRejected, type ScanPolicy } from '../documents/virusScan.js';
import { encodeForStorage } from '../storage/documentEncryption.js';
import { readStoredBlob, writeBlobAtomically } from '../storage/blobFile.js';
import { bufferUpload, soleUpload } from './uploadLimits.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { forbidden } from '../domain/accessProblem.js';
import { sliceChars } from '../domain/textSlice.js';

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

export { safeFilename };

/**
 * RFC 6266 Content-Disposition header value. Provides an ASCII-safe
 * ``filename`` for legacy clients and ``filename*`` with UTF-8 percent-
 * encoding for modern ones that understand RFC 5987.
 *
 * Scrubbed first, which it was not. Two of the callers pass a name that has
 * already been through {@link safeFilename} — but `report.pdf` builds its
 * filename out of `valuation.company_name`, which is bounded and trimmed and
 * nothing else, and that reached the header raw:
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
  const safe = sliceChars(scrubFilename(name) || 'download', 200);
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
        // The stored name, not the one that arrived: this is the name the
        // analyst will look for in the document list, and echoing the raw
        // string puts the controls `safeFilename` exists to remove into a
        // problem body that a browser and a terminal both draw.
        filename: safeFilename(filename),
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
  /**
   * `log` is here for the rollback below, which is the only part of this
   * function that decides something on its own and can be wrong quietly — see
   * the note on `documentPathInUse`. Every other failure is raised.
   */
  options: { scan?: ScanPolicy; log?: FastifyBaseLogger } = {},
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
  const abs = path.join(documentsDir, storageRel);
  // Whether these bytes were already on disk before this upload, asked *before*
  // the write so the answer is still true afterwards. It is the only thing that
  // distinguishes "this request created the blob" from "this request overwrote
  // an identical one", and the rollback below turns on exactly that.
  const preexisting = await access(abs).then(
    () => true,
    () => false,
  );
  // Not `writeFile`. This path is shared — the same bytes under the same name
  // are the same file, and a roll-forward clone copies `storage_path` into
  // another engagement's rows — so truncating it in place is a window in which
  // somebody else's readable document is short. See storage/blobFile.ts.
  await writeBlobAtomically(abs, encodeForStorage(input.buffer));

  try {
    return await createDocument(
      pool,
      {
        valuationId: valuation.id,
        kind: input.kind,
        category: input.category,
        filename,
        // Client-declared, so parsed rather than trusted: it is written to a
        // `text NOT NULL` column and read back out as the download response's own
        // `Content-Type`. See documents/mediaType.ts — a NUL in a multipart part
        // header was a 500, and the length was bounded by nothing.
        contentType: normalizeMediaType(input.contentType),
        sizeBytes: input.buffer.length,
        sha256,
        storagePath: storageRel,
        uploadedBy,
      },
      actor,
    );
  } catch (err) {
    /*
     * The write to disk and the write to the database are two steps, and the
     * second one fails on its own: a retired-engagement trigger, a foreign key
     * against a valuation deleted in the meantime, a pool with no connections
     * left. The upload then answers with an error and the bytes stay on disk
     * forever, under a path no row names.
     *
     * That is not merely litter. A blob nothing references is invisible to
     * every path that reasons about a client's documents — the retention
     * sweep, the Art. 15 personal-data export, the purge — so the one operation
     * that reports having stored nothing is the one that stores a file no
     * later request can find, list, or erase. `documents.storage_path` is the
     * whole index of what this directory holds.
     *
     * Two conditions before removing it, because the path is content-addressed
     * and therefore shared by construction: the same bytes under the same name
     * from any engagement resolve to the same file.
     *
     *   * `preexisting` — if the blob was already there, some earlier upload
     *     put it there and this request only rewrote identical bytes over it.
     *     Deleting it would break that upload's row, turning a failed upload
     *     into somebody else's missing document.
     *   * no live row names it — a concurrent upload of the same bytes may have
     *     inserted its row in the window between our write and our failure, and
     *     that row is now pointing at this file.
     *
     * When the lookup itself fails — the usual reason being that the database
     * is the thing that is unwell — the blob is left alone. An orphan is a
     * bounded cost; deleting a referenced document is not, and this is not the
     * moment to guess.
     */
    if (!preexisting) {
      // The safe answer is also the one that leaves something behind, so it is
      // said out loud (round 267, M11): every failed lookup here is a blob on
      // disk that no row names and nothing will ever collect, and "assume
      // referenced" is indistinguishable on every other surface from a blob
      // that really is.
      const referenced = await documentPathInUse(pool, storageRel).catch((lookupErr: unknown) => {
        options.log?.warn(
          { err: lookupErr, storageRel },
          'could not tell whether the stored file is still referenced — leaving it in place',
        );
        return true;
      });
      // swallow: best-effort cleanup of a file we have just proved unreferenced.
      if (!referenced) await unlink(abs).catch(() => undefined);
    }
    throw err;
  }
}

export function registerDocumentRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; documentsDir: string; autoPipeline?: AutoPipelineDeps; scan?: ScanPolicy },
): void {
  app.post('/api/v1/valuations/:id/documents', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
    refuseIfRetired(valuation, 'accepting documents');

    // Field caps live in `soleUpload` rather than being left to the plugin
    // registration: per-call `limits` and plugin `limits` are merged by
    // @fastify/multipart, but the protection belongs where the upload is, not
    // one file away. `soleUpload` is also what notices a second file, which
    // `req.file()` silently dropped — see routes/uploadLimits.ts.
    const { file, refuseIfMore } = await soleUpload(req, { fileSize: MAX_DOCUMENT_BYTES });

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
    if (buffer.length === 0) {
      // Zero bytes arrived intact — this is not the truncated-upload case,
      // which `bufferUpload` answers. A file that is genuinely empty on disk is
      // usually a failed export or a placeholder somebody has not filled in
      // yet, and re-uploading it changes nothing, so say that rather than
      // inviting a retry.
      //
      // Named through `safeFilename`, for the reason the two refusals below it
      // already are: the name in this sentence is the one the browser sent, and
      // this is the earliest branch it reaches — before `storeDocument` scrubs
      // it — so it was the one place an upload's own name was quoted back raw.
      // A bidi control in it reorders the sentence a person reads (see
      // BIDI_CONTROLS), a C0 control is acted on by the terminal a curl caller
      // is looking at, and nothing bounds its length, so a 200 KB name is a
      // 200 KB problem body.
      const named = safeFilename(file.filename);
      throw problems.unprocessable(
        `“${named}” contains no data — it is zero bytes, so there is nothing to store. ` +
          'Open it to check it saved correctly, then upload it again.',
        { filename: named },
      );
    }

    // Before the type check and well before anything reaches disk: a request
    // offering two documents is refused whole rather than half-stored.
    await refuseIfMore(safeFilename(file.filename));

    // Confirm the bytes match the declared type before the file can feed the AI
    // pipeline or be served back (audit B-1 P2).
    const typeCheck = checkUploadType(file.filename, buffer);
    if (!typeCheck.ok) {
      throw problems.unprocessable(`Rejected upload: ${typeCheck.reason}`, {
        filename: safeFilename(file.filename),
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
      { scan: deps.scan, log: req.log },
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
    return listDocuments(deps.pool, valuation.id, parsed.data);
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
    // The counts, not the files: this checklist states how many uploads each
    // bucket holds and whether a required one is satisfied, and both are wrong
    // when derived from a capped page. `documentCoverage` counts in SQL.
    const coverage = await documentCoverage(deps.pool, valuation.id);
    const categories = summarizeCategories(coverage.byCategory);
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
      } catch (err) {
        req.log.error(
          {
            err,
            valuationId: valuation.id,
            documentId: doc.id,
            storagePath: doc.storage_path,
            alert: true,
          },
          'stored document file is missing from disk while its database row exists — possible storage integrity failure',
        );
        throw problems.notFound('Stored file is missing');
      }
      const plain = readStoredBlob(doc, stored, req.log);

      /*
       * The client's own material leaving, on the record.
       *
       * A document arriving, being re-filed and being removed each wrote an
       * event; the bytes being handed out did not. The report and the evidence
       * bundle both record their reads — "the export itself is an auditable
       * act" — and these are the source materials behind them: audited
       * financials, board minutes, the signed cap table. So the trail could
       * show what an engagement relied on and never who took a copy of it.
       *
       * After `readStoredBlob`, so a stored file that cannot be decrypted
       * refuses and records nothing rather than logging a download that did
       * not happen. The AI tier's reads of the same blobs are deliberately not
       * this event; a pipeline run records itself, and a row per extraction
       * would bury the deliberate downloads this exists to show.
       */
      await withTransaction(deps.pool, (client) =>
        recordEvent(client, {
          valuationId: valuation.id,
          type: PIPELINE_EVENT_TYPES.documentDownloaded,
          actor: actorFor(principal),
          payload: {
            document_id: doc.id,
            filename: doc.filename,
            category: doc.category,
            size_bytes: plain.length,
          },
        }),
      );

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

      const parsed = z.object({ reviewed: z.boolean().default(true) }).strict().safeParse(req.body ?? {});
      if (!parsed.success) throw invalidBody('Invalid body', parsed.error);

      await loadDocument(deps.pool, valuation.id, documentId);
      // 200 either way: the caller asked for a state the file is now in. What
      // `changed` decides is whether the spine gets a row — see the repo.
      const written = await setDocumentReviewed(
        deps.pool,
        documentId,
        parsed.data.reviewed,
        actorFor(principal),
      );
      if (!written) throw problems.notFound();
      return { document: written.document };
    },
  );

  app.delete(
    '/api/v1/valuations/:id/documents/:documentId',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, documentId } = req.params as { id: string; documentId: string };
      const valuation = await loadAuthorizedValuation(deps.pool, principal, id);
      refuseIfRetired(valuation, 'accepting documents');
      const doc = await loadDocument(deps.pool, valuation.id, documentId);

      // Ops can prune anything; everyone else only what they uploaded.
      if (!isOps(principal) && doc.uploaded_by !== principal.id)
        throw forbidden('Deleting this document', 'own-record');
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
