import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { PIPELINE_EVENT_TYPES, type DocumentKind } from '../domain/pipeline.js';
import { recordEvent, type EventActor } from '../events/record.js';

export interface DocumentRow {
  id: string;
  valuation_id: string;
  kind: DocumentKind;
  filename: string;
  content_type: string;
  size_bytes: string | number;
  sha256: string;
  storage_path: string;
  uploaded_by: string | null;
  created_at: Date;
  deleted_at: Date | null;
}

export interface CreateDocumentInput {
  valuationId: string;
  kind: DocumentKind;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  uploadedBy: string;
}

export async function createDocument(
  pool: pg.Pool,
  input: CreateDocumentInput,
  actor: EventActor,
): Promise<DocumentRow> {
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<DocumentRow>(
      `INSERT INTO documents
         (id, valuation_id, kind, filename, content_type, size_bytes, sha256, storage_path, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        input.valuationId,
        input.kind,
        input.filename,
        input.contentType,
        input.sizeBytes,
        input.sha256,
        input.storagePath,
        input.uploadedBy,
      ],
    );
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: PIPELINE_EVENT_TYPES.documentUploaded,
      actor,
      payload: { document_id: id, kind: input.kind, filename: input.filename, size_bytes: input.sizeBytes },
    });
    return rows[0]!;
  });
}

export async function findDocumentById(pool: pg.Pool, id: string): Promise<DocumentRow | null> {
  const { rows } = await pool.query<DocumentRow>(
    'SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  return rows[0] ?? null;
}

export async function listDocuments(pool: pg.Pool, valuationId: string): Promise<DocumentRow[]> {
  const { rows } = await pool.query<DocumentRow>(
    `SELECT * FROM documents
     WHERE valuation_id = $1 AND deleted_at IS NULL
     ORDER BY kind, created_at DESC`,
    [valuationId],
  );
  return rows;
}

/** Soft delete — the file stays on disk for audit; the row is tombstoned. */
export async function deleteDocument(pool: pg.Pool, doc: DocumentRow, actor: EventActor): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('UPDATE documents SET deleted_at = now() WHERE id = $1', [doc.id]);
    await recordEvent(client, {
      valuationId: doc.valuation_id,
      type: PIPELINE_EVENT_TYPES.documentDeleted,
      actor,
      payload: { document_id: doc.id, filename: doc.filename },
    });
  });
}
