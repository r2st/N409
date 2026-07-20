import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { DOCUMENT_KINDS, type DocumentKind } from '../domain/pipeline.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import {
  createDocument,
  deleteDocument,
  findDocumentById,
  listDocuments,
  type DocumentRow,
} from '../repos/documents.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { maybeStartAutoPipeline, type AutoPipelineDeps } from '../pipeline/autoPipeline.js';
import { checkUploadType } from '../documents/fileType.js';
import { decodeFromStorage, encodeForStorage } from '../storage/documentEncryption.js';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const KindField = z.enum(DOCUMENT_KINDS);

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

/** Strip directories and control characters; keep the name recognizable. */
export function safeFilename(name: string): string {
  const base = path.basename(name);
  // Replace path separators, colons, quotes, and any control char (code < 0x20)
  // with '_', collapsing consecutive runs. Avoids a control-char regex literal.
  const bad = new Set(['\\', '/', ':', '"']);
  let cleaned = '';
  let prevReplaced = false;
  for (const ch of base) {
    const isBad = bad.has(ch) || ch.charCodeAt(0) < 0x20;
    if (isBad) {
      if (!prevReplaced) cleaned += '_';
      prevReplaced = true;
    } else {
      cleaned += ch;
      prevReplaced = false;
    }
  }
  cleaned = cleaned.trim();
  return (cleaned || 'upload').slice(0, 200);
}

/**
 * Writes the blob to disk and records the document row + event. Shared by the
 * session upload route below and the partner API (improvement 6).
 */
export async function storeDocument(
  pool: pg.Pool,
  documentsDir: string,
  valuation: ValuationRow,
  input: { kind: DocumentKind; filename: string; contentType: string; buffer: Buffer },
  actor: EventActor,
  uploadedBy: string,
): Promise<DocumentRow> {
  const filename = safeFilename(input.filename);
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

export function registerDocumentRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; documentsDir: string; autoPipeline?: AutoPipelineDeps },
): void {
  app.post('/api/v1/valuations/:id/documents', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadAuthorizedValuation(deps.pool, principal, id);

    const file = await req.file({ limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } });
    if (!file) throw problems.badRequest('Expected a multipart file field named "file"');

    const kindRaw = (file.fields.kind as { value?: string } | undefined)?.value ?? 'other';
    const kindParsed = KindField.safeParse(kindRaw);
    if (!kindParsed.success) {
      throw problems.unprocessable(`Unknown document kind "${kindRaw}"`, {
        allowed: DOCUMENT_KINDS,
      });
    }
    const kind: DocumentKind = kindParsed.data;

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      throw problems.unprocessable(`File exceeds the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit`);
    }
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
      { kind, filename: file.filename, contentType: file.mimetype, buffer },
      actorFor(principal),
      principal.id,
    );

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
    return { documents: await listDocuments(deps.pool, valuation.id) };
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
      // Decrypt in memory (blobs are ≤25 MB) — GCM can't be streamed off disk.
      const plain = decodeFromStorage(stored);
      // nosniff so a stored text/html blob can't be sniffed and rendered
      // inline (audit B-1 P1); attachment already forces a download.
      return reply
        .header('content-type', doc.content_type)
        .header('content-disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`)
        .header('x-content-type-options', 'nosniff')
        .send(plain);
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
      if (!isOps(principal) && doc.uploaded_by !== principal.id) throw problems.forbidden();
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
