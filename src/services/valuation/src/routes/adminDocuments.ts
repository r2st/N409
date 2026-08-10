import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { requirePrincipal } from '../plugins/auth.js';
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_DEFS,
  type DocumentCategory,
} from '../domain/documentCategories.js';
import { refileTarget, suggestCategory } from '../domain/documentTriage.js';
import {
  countUnfiledDocuments,
  findDocumentsByIds,
  listUnfiledDocuments,
  refileDocument,
} from '../repos/documents.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import type { EventActor } from '../events/record.js';

/**
 * Legacy document triage (design §9.2, P2-16).
 *
 * Migration 0112 added seven corporate buckets and moved nothing into them, on
 * purpose: re-filing from a filename is the silent reclassification 0105
 * exists to prevent. The consequence is a backlog — the charters, the option
 * plans, the board consents and the IP schedules uploaded before 0112 are all
 * still sitting in `uploads` together, which is the state 0112 was written to
 * end and could not end by itself.
 *
 * This is the queue that ends it, one human decision at a time. Suggestions
 * are shown and never applied; the write is always an operator naming a
 * bucket, and it lands on the engagement's own event trail because "who
 * decided this was the option plan" is a question asked of the engagement.
 */

const MAX_ASSIGN = 100;

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

export function registerAdminDocumentRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const requireOps = (req: Parameters<typeof requirePrincipal>[0]): Principal => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Document triage is operations-only');
    return principal;
  };

  /**
   * The queue, plus everything the dropdown needs to render.
   *
   * The category catalog rides along rather than being fetched separately: the
   * page cannot render a row without it, and a second round trip is a second
   * thing to be out of date with the validator on the write path.
   */
  app.get('/api/v1/admin/documents/triage', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(200) })
      .safeParse(req.query ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid query', { errors: parsed.error.issues });

    const [rows, total] = await Promise.all([
      listUnfiledDocuments(deps.pool, { limit: parsed.data.limit }),
      countUnfiledDocuments(deps.pool),
    ]);

    const documents = rows.map((d) => ({
      id: d.id,
      valuation_id: d.valuation_id,
      valuation_number: d.valuation_number,
      company_name: d.company_name,
      state: d.state,
      filename: d.filename,
      content_type: d.content_type,
      size_bytes: Number(d.size_bytes),
      uploaded_by_email: d.uploaded_by_email,
      created_at: d.created_at,
      // A suggestion carries the term it matched on, so an operator can check
      // it in the same glance they read the filename. Never pre-selected.
      suggestion: suggestCategory(d.filename),
    }));

    return {
      documents,
      total,
      // The listing is capped; saying so is the difference between "there are
      // 200 of these" and "we showed you 200 of them".
      truncated: total > documents.length,
      max_assign: MAX_ASSIGN,
      categories: DOCUMENT_CATEGORY_DEFS.filter((c) => c.key !== 'uploads').map((c) => ({
        key: c.key,
        label: c.label,
        description: c.description,
      })),
      suggested: documents.filter((d) => d.suggestion !== null).length,
    };
  });

  /**
   * Re-file a selected set.
   *
   * Per-row results rather than all-or-nothing: a stale id in a list an
   * operator has been working through for ten minutes must not discard the
   * nineteen decisions that were still good. Every row is re-checked against
   * the live queue — a document someone else has already filed is reported as
   * such rather than silently re-filed a second time.
   */
  app.post('/api/v1/admin/documents/triage', { preHandler: app.authenticate }, async (req) => {
    const principal = requireOps(req);
    const parsed = z
      .object({
        assignments: z
          .array(
            z.object({
              document_id: z.string(),
              category: z.enum(DOCUMENT_CATEGORIES),
            }),
          )
          .min(1)
          .max(MAX_ASSIGN),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      throw problems.unprocessable('Invalid assignment', { errors: parsed.error.issues });
    }

    const results: Array<{
      document_id: string;
      ok: boolean;
      category?: DocumentCategory;
      error?: string;
    }> = [];

    // One query for the whole batch instead of one per assignment. The queue
    // page has a "select all", so a 200-row batch is the ordinary case and 200
    // sequential round trips were the cost of it before any write happened.
    // Ids that fail the ULID check are left out — they cannot match a row, and
    // passing them would only widen the `ANY` array.
    const documents = await findDocumentsByIds(
      deps.pool,
      parsed.data.assignments.map((a) => a.document_id.toUpperCase()).filter((id) => isUlid(id)),
    );

    for (const assignment of parsed.data.assignments) {
      const id = assignment.document_id.toUpperCase();
      // `uploads` is the bucket being emptied. Accepting it would let a bulk
      // action be a no-op that reports success, which reads as progress.
      if (assignment.category === 'uploads') {
        results.push({
          document_id: assignment.document_id,
          ok: false,
          error: 'Re-filing into “uploads” is not a filing — pick a bucket.',
        });
        continue;
      }
      if (!isUlid(id)) {
        results.push({ document_id: assignment.document_id, ok: false, error: 'Unknown document' });
        continue;
      }
      const doc = documents.get(id);
      if (!doc) {
        results.push({ document_id: id, ok: false, error: 'Unknown document' });
        continue;
      }
      if (doc.category !== 'uploads' || doc.kind !== 'other') {
        results.push({
          document_id: id,
          ok: false,
          error: `Already filed under “${doc.category}” — it may have been triaged since this list was loaded.`,
        });
        continue;
      }
      const target = refileTarget(doc.kind, assignment.category);
      const moved = await refileDocument(deps.pool, doc, target, actorFor(principal));
      // Write the moved row back over the snapshot. The batch is read once, so
      // without this a list that names the same document twice would file it
      // twice — both assignments reading the pre-batch `uploads` state, the
      // second silently overwriting the first's bucket. Re-reading per row is
      // what used to prevent that; keeping the map current does the same
      // without giving back the query.
      documents.set(id, moved);
      results.push({ document_id: id, ok: true, category: target.category });
    }

    const succeeded = results.filter((r) => r.ok).length;
    await recordAdminEvent(deps.pool, {
      type: 'documents_refiled',
      actor: actorFor(principal),
      subjectType: 'document_triage',
      subjectLabel: 'uploads',
      payload: { requested: results.length, succeeded, failed: results.length - succeeded },
    });
    return { results, succeeded, failed: results.length - succeeded };
  });
}
