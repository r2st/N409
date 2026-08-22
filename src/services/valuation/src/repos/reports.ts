import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction, type Queryable } from '../db/pool.js';
import { EVENT_TYPES } from '../domain/valuation.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { lockPublishGate } from './publishLock.js';
import type { ReportContent } from '../domain/report.js';

export interface ReportRow {
  id: string;
  valuation_id: string;
  template_version: string;
  status: 'draft' | 'accepted' | 'changes' | 'published';
  current_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface ReportVersionRow {
  id: string;
  report_id: string;
  version: number;
  content: ReportContent;
  pdf: Buffer | null;
  rendered_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

/**
 * `Queryable` rather than `Pool`: the publish gate reads this row twice, once
 * on the pool to answer the operator quickly and once on the client that is
 * about to write `state`, under the lock. Only the second reading decides
 * anything, and it cannot be taken on a pool.
 */
export async function findReportByValuation(db: Queryable, valuationId: string): Promise<ReportRow | null> {
  const { rows } = await db.query<ReportRow>('SELECT * FROM reports WHERE valuation_id = $1', [valuationId]);
  return rows[0] ?? null;
}

export async function getVersion(
  pool: pg.Pool,
  reportId: string,
  version: number,
): Promise<ReportVersionRow | null> {
  const { rows } = await pool.query<ReportVersionRow>(
    'SELECT * FROM report_versions WHERE report_id = $1 AND version = $2',
    [reportId, version],
  );
  return rows[0] ?? null;
}

/** Version list for the history panel — content itself is fetched per version. */
export async function listVersions(
  pool: pg.Pool,
  reportId: string,
): Promise<Array<Omit<ReportVersionRow, 'content' | 'pdf'> & { has_pdf: boolean }>> {
  const { rows } = await pool.query(
    `SELECT id, report_id, version, rendered_at, created_by, created_at, (pdf IS NOT NULL) AS has_pdf
     FROM report_versions WHERE report_id = $1 ORDER BY version DESC`,
    [reportId],
  );
  return rows as Array<Omit<ReportVersionRow, 'content' | 'pdf'> & { has_pdf: boolean }>;
}

/**
 * Creates the report row plus version 1 from instantiated template content.
 * Runs inside a transaction with the birth event; races on the UNIQUE
 * (valuation_id) constraint surface as a conflict for the caller.
 */
export async function createReport(
  pool: pg.Pool,
  args: {
    valuationId: string;
    templateVersion: string;
    content: ReportContent;
    actor: EventActor;
  },
): Promise<{ report: ReportRow; version: ReportVersionRow }> {
  return withTransaction(pool, async (client) => {
    const { rows: reportRows } = await client.query<ReportRow>(
      `INSERT INTO reports (id, valuation_id, template_version, current_version)
       VALUES ($1, $2, $3, 1)
       RETURNING *`,
      [newUlid(), args.valuationId, args.templateVersion],
    );
    const report = reportRows[0]!;
    const { rows: versionRows } = await client.query<ReportVersionRow>(
      `INSERT INTO report_versions (id, report_id, version, content, created_by)
       VALUES ($1, $2, 1, $3, $4)
       RETURNING *`,
      [newUlid(), report.id, JSON.stringify(args.content), args.actor.actorId ?? null],
    );
    await recordEvent(client, {
      valuationId: args.valuationId,
      type: EVENT_TYPES.reportSaved,
      actor: args.actor,
      payload: { version: 1, template_version: args.templateVersion, origin: 'template' },
    });
    return { report, version: versionRows[0]! };
  });
}

/**
 * The 409 a stale report save is refused with.
 *
 * Both versions are named, as in `staleWrite` in repos/valuations.ts, so the
 * client can tell "somebody else saved" from "my own retry raced itself" and
 * can point at the version that landed. The advice differs deliberately: the
 * valuation's conflict tells the user to reload, which is right for a form of
 * a dozen fields, and wrong here — the refused body is the chapters they have
 * been writing, and reloading is how you lose them.
 */
function staleSave(current: number, expected: number): never {
  throw problems.conflict(
    `This report was changed by someone else (expected version ${expected}, ` +
      `now ${current}). Your draft has not been lost — read version ${current} ` +
      `before saving over it.`,
  );
}

/** Appends a new immutable version and bumps the report pointer. */
export async function saveVersion(
  pool: pg.Pool,
  args: {
    report: ReportRow;
    content: ReportContent;
    actor: EventActor;
    /**
     * The `current_version` the editor's copy of the body was loaded at. When
     * given, the save is refused if somebody else has saved since.
     *
     * Checked under the row lock below rather than against `args.report`, which
     * is read outside the transaction: the whole failure this guards is another
     * writer landing between that read and this write, so a check against the
     * caller's own copy would be blind to exactly the case it exists for.
     */
    expectedVersion?: number;
    /**
     * Audit trail: 'editor' for a save, the version a revert restored, or the
     * skeleton a re-draft instantiated.
     */
    origin: 'editor' | { revertedFrom: number } | { redraftedFrom: string };
    /**
     * Moves the report onto a new skeleton. Only the re-draft path passes it —
     * an ordinary save keeps the version the body was authored against, because
     * `template_version` is what the cover page states the document was drawn
     * from and editing prose does not change that.
     */
    templateVersion?: string;
  },
): Promise<{ report: ReportRow; version: ReportVersionRow }> {
  return withTransaction(pool, async (client) => {
    /*
     * The publish gate's lock, taken before the report's own row lock.
     *
     * Rule 3 of `assertPublishGate` compares `reports.current_version` against
     * the version the last QA review graded, and this function is the writer
     * that moves the left-hand side. Without this the rule closes the ordinary
     * case and leaves the interleaved one exactly as it was: the gate reads
     * version 3 against a review of version 3, this save commits version 4, and
     * the publish lands on a body no review has seen — the same shape as the
     * signature deleted mid-publish, which is what the lock class was
     * introduced for.
     *
     * Before the `FOR UPDATE` rather than after, so the two locks are always
     * taken in that order here and in the gate; the reverse pairing anywhere
     * else would be a deadlock waiting for load.
     */
    await lockPublishGate(client, args.report.valuation_id);
    // Re-read the pointer under lock so concurrent saves can't collide on version.
    const { rows: lockedRows } = await client.query<ReportRow>(
      'SELECT * FROM reports WHERE id = $1 FOR UPDATE',
      [args.report.id],
    );
    const locked = lockedRows[0]!;
    if (args.expectedVersion !== undefined && args.expectedVersion !== locked.current_version) {
      staleSave(locked.current_version, args.expectedVersion);
    }
    const nextVersion = locked.current_version + 1;

    const { rows: versionRows } = await client.query<ReportVersionRow>(
      `INSERT INTO report_versions (id, report_id, version, content, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [newUlid(), locked.id, nextVersion, JSON.stringify(args.content), args.actor.actorId ?? null],
    );
    const { rows: reportRows } = await client.query<ReportRow>(
      `UPDATE reports
          SET current_version = $1,
              template_version = COALESCE($3, template_version),
              updated_at = now()
        WHERE id = $2
      RETURNING *`,
      [nextVersion, locked.id, args.templateVersion ?? null],
    );

    const restored =
      typeof args.origin === 'object' && 'revertedFrom' in args.origin ? args.origin.revertedFrom : null;
    const redrafted =
      typeof args.origin === 'object' && 'redraftedFrom' in args.origin ? args.origin.redraftedFrom : null;
    await recordEvent(client, {
      valuationId: locked.valuation_id,
      type: restored !== null ? EVENT_TYPES.reportReverted : EVENT_TYPES.reportSaved,
      actor: args.actor,
      payload: {
        version: nextVersion,
        ...(restored !== null ? { restored_version: restored } : {}),
        // A re-draft is a save — the body is new content on a new version — but
        // one whose provenance is a skeleton rather than a person, and an audit
        // reader needs to be able to tell the two apart.
        ...(redrafted !== null ? { redrafted_from_template: redrafted } : {}),
      },
    });
    return { report: reportRows[0]!, version: versionRows[0]! };
  });
}

/** Stores the rendered PDF on its version row and records the event. */
export async function storeRenderedPdf(
  pool: pg.Pool,
  args: { report: ReportRow; version: number; pdf: Buffer; actor: EventActor },
): Promise<ReportVersionRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<ReportVersionRow>(
      `UPDATE report_versions SET pdf = $1, rendered_at = now()
       WHERE report_id = $2 AND version = $3
       RETURNING *`,
      [args.pdf, args.report.id, args.version],
    );
    const row = rows[0];
    if (!row) throw new Error(`report version ${args.version} not found for report ${args.report.id}`);
    await recordEvent(client, {
      valuationId: args.report.valuation_id,
      type: EVENT_TYPES.reportRendered,
      actor: args.actor,
      payload: { version: args.version, size_bytes: args.pdf.length },
    });
    return row;
  });
}
