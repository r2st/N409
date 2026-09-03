import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import type { ValuationKind } from '../domain/valuation.js';

export type ReportTemplateStatus = 'draft' | 'active' | 'archived';

export interface ReportTemplateRow {
  id: string;
  name: string;
  version: number;
  kind: ValuationKind;
  status: ReportTemplateStatus;
  body: string;
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The rendered handle, e.g. "409a.v53". */
export function templateLabel(t: Pick<ReportTemplateRow, 'name' | 'version'>): string {
  return `${t.name}.v${t.version}`;
}

/**
 * The active managed template for a kind, if any (gap 6 — template bodies
 * merge into newly created reports). Newest activation wins when several
 * template names target the same kind.
 */
export async function findActiveTemplateForKind(
  pool: pg.Pool,
  kind: ValuationKind,
): Promise<ReportTemplateRow | null> {
  const { rows } = await pool.query<ReportTemplateRow>(
    `SELECT * FROM report_templates
     WHERE kind = $1 AND status = 'active' AND btrim(body) <> ''
     ORDER BY updated_at DESC
     LIMIT 1`,
    [kind],
  );
  return rows[0] ?? null;
}

export const TEMPLATE_PAGE_LIMIT = 200;

/**
 * Report templates, grouped by name and newest version first — a page of them.
 *
 * Every edit to a template mints a *new row* rather than updating one (see
 * {@link createTemplateVersion}), and archived versions are kept because a
 * published report names the version it was set from. So this table grows with
 * every edit anyone has ever made, and it carries the full template body on
 * each row. The unfiltered list is the one the admin screen opens with.
 *
 * `findActiveTemplateForKind` is a `LIMIT 1` of its own, so which template a
 * render picks up is not affected by this cap; nor is
 * {@link createTemplateVersion}, which takes `max(version)` in SQL under the
 * name lock. This is the browse path only.
 */
/**
 * Every column but the body (R398, methodology M8).
 *
 * The cap above is the reason this exists and was not the whole answer. A
 * template body is the report skeleton and the create route accepts a million
 * characters of it, so a page of this list is up to 200 MB of document — read
 * off the table, assembled by the driver, serialised to JSON and sent to a
 * browser that draws a five-column table of labels, statuses and timestamps.
 *
 * `TemplatesPage` reads exactly one body: the row whose Edit button was
 * pressed, which is a draft, one at a time, and which has `GET
 * /report-templates/:id` to fetch it from. So this is not a body the list
 * declines to send early — it is a body no caller of the list ever read.
 *
 * Spelled out rather than `SELECT *` minus one, because there is no such SQL,
 * and the type below is what carries the omission into the compiler.
 */
const TEMPLATE_SUMMARY_COLUMNS = `id, name, version, kind, status, notes,
       created_by, created_at, updated_at`;

/** A row as the browse path returns it: everything the page draws, no body. */
export type ReportTemplateSummary = Omit<ReportTemplateRow, 'body'>;

export async function listTemplates(
  pool: pg.Pool,
  filters: { name?: string; kind?: ValuationKind; status?: ReportTemplateStatus; limit?: number } = {},
): Promise<{ templates: ReportTemplateSummary[]; truncated: boolean }> {
  const limit = Math.min(Math.max(filters.limit ?? TEMPLATE_PAGE_LIMIT, 1), TEMPLATE_PAGE_LIMIT);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (filters.name) add('name = ?', filters.name);
  if (filters.kind) add('kind = ?', filters.kind);
  if (filters.status) add('status = ?', filters.status);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit + 1);
  const { rows } = await pool.query<ReportTemplateSummary>(
    `SELECT ${TEMPLATE_SUMMARY_COLUMNS} FROM report_templates ${whereSql}
      ORDER BY name ASC, version DESC LIMIT $${params.length}`,
    params,
  );
  return { templates: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function findTemplateById(pool: pg.Pool, id: string): Promise<ReportTemplateRow | null> {
  const { rows } = await pool.query<ReportTemplateRow>('SELECT * FROM report_templates WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * Advisory-lock namespace for "everything that writes the version history of
 * one template name". Paired with `hashtext(name)` as the second key, so the
 * lock is per-name; an incidental hash collision between two names only costs
 * a little serialization, never correctness.
 */
const TEMPLATE_NAME_LOCK = 0x74706c6;

/** Serializes the read-then-write on one template name for this transaction. */
async function lockTemplateName(client: pg.PoolClient, name: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [TEMPLATE_NAME_LOCK, name]);
}

/**
 * Creates the next version of `name` (v1 when the name is new). New versions
 * always start as drafts; activation is an explicit step.
 */
export async function createTemplateVersion(
  pool: pg.Pool,
  input: { name: string; kind: ValuationKind; body?: string; notes?: string; createdBy: string },
): Promise<ReportTemplateRow> {
  return withTransaction(pool, async (client) => {
    // The `FOR UPDATE` this replaces did not serialize anything.
    //
    // For a brand-new name there is no row to lock, and Postgres has no gap
    // lock to stand in for one — so concurrent creates all read "no versions"
    // and all pick v1. For a name that does exist it locked only the row the
    // `LIMIT 1` returned: a waiter that blocks on that row re-checks *that
    // row* when the lock clears, not the query, so it never sees the higher
    // version the other transaction just inserted and picks the same next
    // number.
    //
    // Either way `UNIQUE (name, version)` rejects everyone but the winner, and
    // the route has no handler for it, so the losers surface as 500s — what an
    // ops admin gets from a double-clicked "New template". A transaction-scoped
    // advisory lock on the name serializes the read and the insert together.
    await lockTemplateName(client, input.name);
    const { rows: last } = await client.query<{ version: number }>(
      'SELECT version FROM report_templates WHERE name = $1 ORDER BY version DESC LIMIT 1',
      [input.name],
    );
    const version = (last[0]?.version ?? 0) + 1;
    const { rows } = await client.query<ReportTemplateRow>(
      `INSERT INTO report_templates (id, name, version, kind, body, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [newUlid(), input.name, version, input.kind, input.body ?? '', input.notes ?? null, input.createdBy],
    );
    return rows[0]!;
  });
}

/** Drafts are editable; active/archived versions are immutable history. */
export async function updateDraftTemplate(
  pool: pg.Pool,
  id: string,
  fields: { body?: string; notes?: string | null },
): Promise<ReportTemplateRow | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  if (fields.body !== undefined) {
    params.push(fields.body);
    sets.push(`body = $${params.length}`);
  }
  if (fields.notes !== undefined) {
    params.push(fields.notes);
    sets.push(`notes = $${params.length}`);
  }
  params.push(id);
  const { rows } = await pool.query<ReportTemplateRow>(
    `UPDATE report_templates SET ${sets.join(', ')}
     WHERE id = $${params.length} AND status = 'draft'
     RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

/** Activates a version, archiving whichever version of the name was active. */
export async function activateTemplate(pool: pg.Pool, id: string): Promise<ReportTemplateRow | null> {
  return withTransaction(pool, async (client) => {
    // Locking the target row is not enough: activating two *different*
    // versions of one name concurrently locks two different rows, so neither
    // transaction waits. Both then run the "archive the active one" update —
    // the second finds nothing left to archive, because the first already
    // did — and both go on to set their own row active, which the partial
    // unique index `report_templates_one_active_per_name` rejects with a 500.
    //
    // Which version of the name is live is a property of the *name*, so that
    // is what has to be serialized. Read the name first, take the lock, then
    // re-read the row under it: whoever arrives second now sees the state the
    // first one left, and either archives it cleanly or no-ops.
    const { rows: named } = await client.query<{ name: string }>(
      'SELECT name FROM report_templates WHERE id = $1',
      [id],
    );
    if (!named[0]) return null;
    await lockTemplateName(client, named[0].name);

    const { rows: target } = await client.query<ReportTemplateRow>(
      'SELECT * FROM report_templates WHERE id = $1 FOR UPDATE',
      [id],
    );
    const template = target[0];
    if (!template || template.status === 'active') return template ?? null;
    /*
     * The route's own refusal, made again under the lock.
     *
     * `POST /report-templates/:id/activate` refuses an archived version —
     * "Archived versions cannot be re-activated — create a new version" — and
     * that read is on the pool, one statement before this transaction opens.
     * The lock above was added for a different race and re-checked a different
     * predicate, so a `POST /:id/archive` committing in between walked straight
     * through it: the version came back from 'archived' to 'active', and on the
     * way it archived whichever version of the name the operator had put live
     * instead. The withdrawn skeleton every new report of that kind is built
     * from, restored by a request that had been told it could not be.
     *
     * Thrown rather than returned as a no-op: an activate that answers 200 over
     * a version it did not activate is the discarded failure this codebase keeps
     * finding, and the caller asked for a state change it did not get.
     */
    if (template.status === 'archived') {
      throw problems.conflict('Archived versions cannot be re-activated — create a new version');
    }
    await client.query(
      `UPDATE report_templates SET status = 'archived', updated_at = now()
       WHERE name = $1 AND status = 'active'`,
      [template.name],
    );
    const { rows } = await client.query<ReportTemplateRow>(
      `UPDATE report_templates SET status = 'active', updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    return rows[0]!;
  });
}

/**
 * Retire a version. Under the name lock, like the activation it races.
 *
 * `activateTemplate` is two writes — archive whichever version of the name is
 * live, then set this one active — and the lock exists so the pair is
 * indivisible. This is the other half of the same invariant and it took no
 * lock at all, so it could land *between* those two writes: the activation
 * archives the incumbent, this archives the version being promoted, the
 * activation then sets it active, and the operator who asked for the archive
 * is told it happened while the version they retired is the live skeleton
 * every new report of that kind is built from. Run the other way round — the
 * archive lands after both writes — the name is left with no active version
 * and the activation's 200 described a state that survived for one statement.
 *
 * Serialised, both orderings are answers rather than accidents: either the
 * archive happens and the activation finds nothing to promote out of, or the
 * activation completes and the archive retires what it promoted. Leaving a
 * kind with no managed template is a thing ops is allowed to do — the render
 * falls back — so this refuses nothing; it only stops the two from
 * interleaving.
 *
 * `changed` is false for a version that was already archived. `updated_at` and
 * the `template_archived` trail line are the entire record of who retired a
 * skeleton and when, and the admin screen lists archived versions with the
 * control still on them — so a second press moved the date and put a second
 * retirement on the trail for one retirement. Same reading as
 * `setContactSubmissionStatus`: the row comes back either way, and `changed` is
 * what tells the route whether there is a transition to record.
 */
export async function archiveTemplate(
  pool: pg.Pool,
  id: string,
): Promise<{ template: ReportTemplateRow; changed: boolean } | null> {
  return withTransaction(pool, async (client) => {
    const { rows: named } = await client.query<{ name: string }>(
      'SELECT name FROM report_templates WHERE id = $1',
      [id],
    );
    if (!named[0]) return null;
    await lockTemplateName(client, named[0].name);

    const { rows } = await client.query<ReportTemplateRow>(
      `UPDATE report_templates SET status = 'archived', updated_at = now()
        WHERE id = $1 AND status <> 'archived'
        RETURNING *`,
      [id],
    );
    if (rows[0]) return { template: rows[0], changed: true };
    const { rows: current } = await client.query<ReportTemplateRow>(
      'SELECT * FROM report_templates WHERE id = $1',
      [id],
    );
    return current[0] ? { template: current[0], changed: false } : null;
  });
}
