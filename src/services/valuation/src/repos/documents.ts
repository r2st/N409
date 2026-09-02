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
  /** Cleared by an analyst (0121) — what the "pending files" counter counts. */
  reviewed_at: Date | null;
  reviewed_by: string | null;
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

/**
 * Does any document row still name this blob?
 *
 * Storage paths are content-addressed (`<valuationId>/<sha-prefix>__<name>`), so
 * two uploads of the same bytes under the same name share one file. That makes
 * "can this file be deleted" a question about rows rather than about the
 * request that wrote it — see `storeDocument`'s rollback, which is the only
 * caller.
 *
 * `deleted_at` is deliberately not filtered. A soft-deleted document is a row
 * that can be restored and whose bytes nothing else has removed; treating it as
 * absent would let a failed upload delete the file underneath it.
 */
export async function documentPathInUse(pool: pg.Pool, storagePath: string): Promise<boolean> {
  const { rows } = await pool.query<{ one: number }>(
    'SELECT 1 AS one FROM documents WHERE storage_path = $1 LIMIT 1',
    [storagePath],
  );
  return rows.length > 0;
}

export async function findDocumentById(pool: pg.Pool, id: string): Promise<DocumentRow | null> {
  const { rows } = await pool.query<DocumentRow>(
    'SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Batch counterpart to findDocumentById, keyed by id for O(1) lookup.
 *
 * The bulk re-filing action fetched one document per assignment, so clearing a
 * triage queue of 200 files cost 200 sequential round trips before the first
 * write — the queue page offers "select all", so the large batch is the normal
 * one, not the edge case. `= ANY($1)` collapses that to a single query.
 *
 * Ids that are missing, deleted, or simply not documents are absent from the
 * map rather than being an error: the caller reports per-item outcomes and
 * already has to say "unknown document" for a row someone else removed while
 * the queue was on screen.
 */
export async function findDocumentsByIds(pool: pg.Pool, ids: string[]): Promise<Map<string, DocumentRow>> {
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query<DocumentRow>(
    'SELECT * FROM documents WHERE id = ANY($1) AND deleted_at IS NULL',
    [[...new Set(ids)]],
  );
  return new Map(rows.map((row) => [row.id, row]));
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
export const DOCUMENT_PAGE_LIMIT = 500;

export async function listDocuments(
  pool: pg.Pool,
  valuationId: string,
  filter: { category?: DocumentCategory } = {},
): Promise<{ documents: DocumentRow[]; truncated: boolean }> {
  const { rows } = await pool.query<DocumentRow>(
    `SELECT * FROM documents
     WHERE valuation_id = $1 AND deleted_at IS NULL
       AND ($2::document_category IS NULL OR category = $2)
     ORDER BY category, kind, created_at DESC
     LIMIT $3`,
    [valuationId, filter.category ?? null, DOCUMENT_PAGE_LIMIT + 1],
  );
  return {
    documents: rows.slice(0, DOCUMENT_PAGE_LIMIT),
    truncated: rows.length > DOCUMENT_PAGE_LIMIT,
  };
}

/** What {@link documentCoverage} answers — counts, never rows. */
export interface DocumentCoverage {
  /** Live documents on the engagement. Counted in SQL, so it is exact. */
  total: number;
  /** How many live documents carry each kind. Absent kinds are simply absent. */
  byKind: Map<DocumentKind, number>;
  /** The same, per intake bucket. */
  byCategory: Map<DocumentCategory, number>;
}

/**
 * The document checklist's arithmetic, answered in SQL.
 *
 * Three callers asked {@link listDocuments} for the whole list and then reduced
 * it to a handful of numbers — the progress tracker's per-kind checklist and
 * `documents_uploaded`, and the completeness score's set of covered buckets.
 * Capping the list would have made every one of those answers wrong in the
 * direction nobody checks: an engagement past the cap reads as *missing* the
 * bucket whose files sit beyond it, which is a checklist item a client is then
 * asked to satisfy twice.
 *
 * So the cap and the counts are separated. `kind` and `category` are both
 * enums, so this result is bounded by their product no matter how many files
 * an engagement holds, and every count in it is exact.
 */
export async function documentCoverage(pool: pg.Pool, valuationId: string): Promise<DocumentCoverage> {
  const { rows } = await pool.query<{ kind: DocumentKind; category: DocumentCategory; count: string }>(
    `SELECT kind, category, count(*)::text AS count
       FROM documents
      WHERE valuation_id = $1 AND deleted_at IS NULL
      GROUP BY kind, category`,
    [valuationId],
  );
  const coverage: DocumentCoverage = { total: 0, byKind: new Map(), byCategory: new Map() };
  for (const row of rows) {
    const n = Number(row.count);
    coverage.total += n;
    coverage.byKind.set(row.kind, (coverage.byKind.get(row.kind) ?? 0) + n);
    coverage.byCategory.set(row.category, (coverage.byCategory.get(row.category) ?? 0) + n);
  }
  return coverage;
}

/**
 * Whether any live document on this engagement can feed text extraction.
 *
 * An existence question, asked as one. The pipeline trigger read the whole
 * document list to run `.some(isExtractable)` over it, so past the cap it would
 * have refused to start a run on an engagement that does hold an extractable
 * file — a refusal with a remedy ("upload one first") the user has already met.
 *
 * The extension test is `isExtractable`'s, moved into SQL so the two cannot
 * drift: the suffix list is passed in rather than restated here, and
 * `lower(filename) LIKE ANY` matches what `path.extname().toLowerCase()` does
 * for every name that has an extension at all.
 */
export async function hasExtractableDocument(
  pool: pg.Pool,
  valuationId: string,
  extensions: readonly string[],
): Promise<boolean> {
  if (extensions.length === 0) return false;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM documents
      WHERE valuation_id = $1 AND deleted_at IS NULL
        AND lower(filename) LIKE ANY ($2::text[])
      LIMIT 1`,
    [valuationId, extensions.map((e) => `%${e.toLowerCase()}`)],
  );
  return (rowCount ?? 0) > 0;
}

export interface UnfiledDocumentRow extends DocumentRow {
  valuation_number: number;
  company_name: string;
  state: string;
  uploaded_by_email: string | null;
}

/**
 * The legacy re-filing queue (design §9.2).
 *
 * `category = 'uploads' AND kind = 'other'` is deliberately both conditions
 * and not just the first. A file in `uploads` whose kind is `cap_table` was
 * filed there on purpose by somebody who saw the choices — the client who
 * considered it incidental, or the API caller who stated a kind and no
 * category. The rows that are genuinely uncategorised, and therefore the ones
 * a human should look at, are the ones the platform knows nothing about on
 * either axis.
 *
 * Oldest first: the backlog 0112 left is at the far end of the table, and a
 * queue that opens on this morning's uploads is a queue nobody finishes.
 */
export async function listUnfiledDocuments(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<UnfiledDocumentRow[]> {
  const { rows } = await pool.query<UnfiledDocumentRow>(
    `SELECT d.*, v.number AS valuation_number, v.state, v.company_name,
            u.email AS uploaded_by_email
       FROM documents d
       JOIN valuations v ON v.id = d.valuation_id
       LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.deleted_at IS NULL
        AND v.archived_at IS NULL
        AND d.category = 'uploads'
        AND d.kind = 'other'
      ORDER BY d.created_at ASC
      LIMIT $1`,
    [opts.limit ?? 500],
  );
  return rows;
}

/**
 * How many rows the queue holds in total, regardless of the page limit.
 *
 * The engagement join is here only to carry `archived_at`, which is why it is
 * an EXISTS rather than a JOIN — the count must not change shape if a document
 * ever outlives its valuation. It has to be here at all because this number is
 * rendered beside `listUnfiledDocuments`, and a count that included retired
 * engagements while the list below it excluded them is the firm-console bug
 * again: a header reading 15 above a list of 12, with nothing on the page to
 * reconcile them.
 */
export async function countUnfiledDocuments(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM documents d
      WHERE d.deleted_at IS NULL AND d.category = 'uploads' AND d.kind = 'other'
        AND EXISTS (
          SELECT 1 FROM valuations v
           WHERE v.id = d.valuation_id AND v.archived_at IS NULL
        )`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Re-file one document into a named bucket, from the bucket the caller read.
 *
 * Writes an event on the engagement rather than only an admin event: a
 * document's filing is part of the evidence record, and "who decided this was
 * the option plan, and when" is a question an auditor asks of the engagement,
 * not of the platform. The previous bucket rides in the payload so the change
 * is reversible from the trail alone.
 *
 * THE BUCKET IT IS MOVING *FROM* IS PART OF THE WRITE. Its only caller is the
 * triage queue, whose rule is that a row may be filed once — it refuses a
 * document that is no longer `uploads`/`other` with "it may have been triaged
 * since this list was loaded". That refusal was decided in TypeScript against a
 * snapshot read one statement earlier, on another connection, and the UPDATE
 * under it named no state at all. Two operators working the same "select all",
 * or the same operator's double-click, both read `uploads`, both passed the
 * check and both wrote: the second silently overwrote the first's filing, and
 * put a `document_refiled` on the spine claiming it came *from* `uploads` when
 * it came from wherever the first operator had just put it. The payload the
 * doc-comment above calls reversible then describes a move that did not happen.
 *
 * `deleted_at IS NULL` closes the same window against the delete: the caller's
 * read filters tombstones (`findDocumentsByIds`) and the delete lands in
 * between, so without it a removed document gets re-filed and a refile event
 * arrives on the engagement's trail after the deletion event.
 *
 * Null when the row is no longer as it was read — nothing written, no event.
 * The caller reports it as the per-row refusal it already has wording for; a
 * whole-batch failure is not what one moved document means.
 */
export async function refileDocument(
  pool: pg.Pool,
  doc: DocumentRow,
  target: { category: DocumentCategory; kind: DocumentKind },
  actor: EventActor,
): Promise<DocumentRow | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<DocumentRow>(
      `UPDATE documents SET category = $2, kind = $3
        WHERE id = $1 AND deleted_at IS NULL AND category = $4 AND kind = $5
        RETURNING *`,
      [doc.id, target.category, target.kind, doc.category, doc.kind],
    );
    if (!rows[0]) return null;
    await recordEvent(client, {
      valuationId: doc.valuation_id,
      type: PIPELINE_EVENT_TYPES.documentRefiled,
      actor,
      // A change list rather than four `from_`/`to_` keys (round 389,
      // methodology M4). `extractChanges` reads `changes`, a bare `from`/`to`
      // pair, `fields` and `engine_inputs_applied`; this was a fifth spelling
      // of the first, so the two pairs a re-file is entirely made of reached
      // neither the trail nor the change log — the CSV emitted no row for the
      // event at all, and "was this document reclassified, and from what?" is
      // the only question asked of it.
      payload: {
        document_id: doc.id,
        filename: doc.filename,
        changes: {
          category: { from: doc.category, to: target.category },
          kind: { from: doc.kind, to: target.kind },
        },
      },
    });
    return rows[0]!;
  });
}

/**
 * Mark a document reviewed, or put it back in the pending pile (0121).
 *
 * The un-review is not symmetry for its own sake: the counter's whole value is
 * that it reaches zero, and an analyst who cleared a row by mistake with no way
 * back would either leave the count wrong or re-upload the file. `reviewed_by`
 * is cleared with the timestamp so a pending row never carries a stale name.
 */
export async function setDocumentReviewed(
  pool: pg.Pool,
  documentId: string,
  reviewed: boolean,
  reviewerId: string,
): Promise<DocumentRow | null> {
  const { rows } = await pool.query<DocumentRow>(
    `UPDATE documents
        SET reviewed_at = CASE WHEN $2 THEN now() ELSE NULL END,
            reviewed_by = CASE WHEN $2 THEN $3::ulid ELSE NULL END
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
    [documentId, reviewed, reviewerId],
  );
  return rows[0] ?? null;
}

/**
 * Soft delete — the file stays on disk for audit; the row is tombstoned.
 *
 * `AND deleted_at IS NULL` is what makes it happen once. The route reads the
 * row through `findDocumentById`, which filters tombstones, so it can only ever
 * reach a live document — but that read is on a different connection one
 * statement earlier, and two DELETEs off one read is a double-clicked button.
 * Every other soft delete in this service already asks the question
 * (`revokeApiToken`, `revokeIntakeLink`, `revokeAuditorAccess`, `softDeleteUser`,
 * the SCIM toggle); this one did not, and the second write cost two things:
 *
 *   * A second `document_deleted` on an append-only spine, for one deletion.
 *     `documents_deleted` counters and the activity log both read that trail,
 *     and the row a reviewer sees twice describes a thing that happened once.
 *   * `deleted_at` moved. It is the date `personalDataExport` gives the subject
 *     for their own uploads, and the one the audit view prints for a file the
 *     analyst says was removed in March.
 *
 * Losing the race writes nothing at all — no timestamp, no event — because the
 * document is already gone and the caller's own outcome is unchanged either
 * way. Same reading as `completeAiJob`'s late worker: it asked for a state the
 * row is already in, so there is nothing for it to do differently.
 */
export async function deleteDocument(pool: pg.Pool, doc: DocumentRow, actor: EventActor): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      'UPDATE documents SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
      [doc.id],
    );
    if (rowCount === 0) return;
    await recordEvent(client, {
      valuationId: doc.valuation_id,
      type: PIPELINE_EVENT_TYPES.documentDeleted,
      actor,
      payload: { document_id: doc.id, filename: doc.filename },
    });
  });
}
