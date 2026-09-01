import type pg from 'pg';
import { newUlid } from '@n409/shared';

/** Public marketing contact form submissions (409.ai gap #28). */

export type ContactSubmissionStatus = 'new' | 'handled';

export interface ContactSubmissionRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  message: string;
  status: ContactSubmissionStatus;
  handled_by: string | null;
  handled_at: Date | null;
  created_at: Date;
}

export async function createContactSubmission(
  pool: pg.Pool,
  input: {
    name: string;
    email: string;
    company?: string | null;
    phone?: string | null;
    message: string;
  },
): Promise<ContactSubmissionRow> {
  const { rows } = await pool.query<ContactSubmissionRow>(
    `INSERT INTO contact_submissions (id, name, email, company, phone, message)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [newUlid(), input.name, input.email, input.company ?? null, input.phone ?? null, input.message],
  );
  return rows[0]!;
}

/**
 * Ceiling on one page of the contact inbox. Same shape and same reason as
 * {@link SUPPORT_MESSAGE_PAGE_LIMIT}: status-first ordering means the cap eats
 * the oldest `new` enquiry once the closed ones outnumber the page, and a
 * sales enquiry nobody can see is one nobody answers.
 */
export const CONTACT_SUBMISSION_PAGE_LIMIT = 200;

export async function listContactSubmissions(
  pool: pg.Pool,
  filters: { status?: ContactSubmissionStatus; limit?: number } = {},
): Promise<{ submissions: ContactSubmissionRow[]; truncated: boolean }> {
  const params: unknown[] = [];
  let where = '';
  if (filters.status) {
    params.push(filters.status);
    where = `WHERE status = $${params.length}`;
  }
  const limit = Math.min(
    Math.max(filters.limit ?? CONTACT_SUBMISSION_PAGE_LIMIT, 1),
    CONTACT_SUBMISSION_PAGE_LIMIT,
  );
  params.push(limit + 1);
  const { rows } = await pool.query<ContactSubmissionRow>(
    `SELECT * FROM contact_submissions
     ${where}
     ORDER BY status ASC, created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return { submissions: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * Move a submission between `new` and `handled`, once per transition.
 *
 * `WHERE status <> $2` is the whole point, and it is two guards in one. The
 * route reads nothing before calling — there is no prior row to compare
 * against — so the only thing that can say whether this call is a transition
 * is the statement that makes it.
 *
 * Unconditional, a second "mark handled" re-stamped `handled_by` and
 * `handled_at`. Those two columns are the entire record of who answered a
 * prospect and when: nothing else on this surface is written anywhere, so the
 * row *is* the audit trail. A colleague opening the queue and pressing Handled
 * on a row that was already handled — which is what the button offers, because
 * the list shows handled rows — took the answer off the person who gave it and
 * moved the date to today. A double-click did the same thing to its own writer.
 *
 * The row comes back either way, so a repeat is a 200 over the ending that
 * stands rather than an error; `changed` is what tells the route whether there
 * is a transition to record.
 */
export interface ContactSubmissionWrite {
  submission: ContactSubmissionRow;
  changed: boolean;
}

export async function setContactSubmissionStatus(
  pool: pg.Pool,
  id: string,
  status: ContactSubmissionStatus,
  handledBy: string,
): Promise<ContactSubmissionWrite | null> {
  const { rows } = await pool.query<ContactSubmissionRow>(
    `UPDATE contact_submissions
     SET status = $2::contact_submission_status,
         handled_by = CASE WHEN $2::text = 'handled' THEN $3 ELSE NULL END,
         handled_at = CASE WHEN $2::text = 'handled' THEN now() ELSE NULL END
     WHERE id = $1 AND status <> $2::contact_submission_status
     RETURNING *`,
    [id, status, handledBy],
  );
  if (rows[0]) return { submission: rows[0], changed: true };
  const existing = await findContactSubmission(pool, id);
  return existing ? { submission: existing, changed: false } : null;
}

export async function findContactSubmission(pool: pg.Pool, id: string): Promise<ContactSubmissionRow | null> {
  const { rows } = await pool.query<ContactSubmissionRow>('SELECT * FROM contact_submissions WHERE id = $1', [
    id,
  ]);
  return rows[0] ?? null;
}
