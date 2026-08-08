import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { PIPELINE_EVENT_TYPES, type DocumentKind } from '../domain/pipeline.js';
import { categoryForKind, type DocumentCategory } from '../domain/documentCategories.js';
import { recordEvent, type EventActor } from '../events/record.js';

export interface DocumentRow {
  id: string;
  valuation_id: string;
  kind: DocumentKind;
  /** The intake bucket this upload answers (0105); see domain/documentCategories.ts. */
  category: DocumentCategory;
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
  /**
   * Intake bucket (0105). Optional: the kind implies one for every caller that
   * has no client in front of it to ask — the AI pipeline, the partner API, a
   * sync job — and leaving it to each of them to remember is how a row ends up
   * uncategorized. Only the upload form, where a client can state the period of
   * an income statement, has anything the kind does not already say.
   */
  category?: DocumentCategory;
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
         (id, valuation_id, kind, category, filename, content_type, size_bytes, sha256, storage_path, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        id,
        input.valuationId,
        input.kind,
        input.category ?? categoryForKind(input.kind),
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
      payload: {
        document_id: id,
        kind: input.kind,
        category: input.category ?? categoryForKind(input.kind),
        filename: input.filename,
        size_bytes: input.sizeBytes,
      },
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

/**
 * The engagement's live files, grouped by bucket.
 *
 * `ORDER BY category` is the enum's order and therefore roughly the checklist's
 * — close enough for a list, and `documents_category_idx` (0105) serves the
 * filtered form directly. Thirteen buckets (0112) is the reason the filter
 * exists at all: six was a list you could read, thirteen is one an analyst
 * looking for the option plan has to search.
 */
export async function listDocuments(
  pool: pg.Pool,
  valuationId: string,
  filter: { category?: DocumentCategory } = {},
): Promise<DocumentRow[]> {
  const { rows } = await pool.query<DocumentRow>(
    `SELECT * FROM documents
     WHERE valuation_id = $1 AND deleted_at IS NULL
       AND ($2::document_category IS NULL OR category = $2)
     ORDER BY category, kind, created_at DESC`,
    [valuationId, filter.category ?? null],
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
