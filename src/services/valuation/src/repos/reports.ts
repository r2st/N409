import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { EVENT_TYPES } from '../domain/valuation.js';
import { recordEvent, type EventActor } from '../events/record.js';
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

export async function findReportByValuation(pool: pg.Pool, valuationId: string): Promise<ReportRow | null> {
  const { rows } = await pool.query<ReportRow>('SELECT * FROM reports WHERE valuation_id = $1', [
    valuationId,
  ]);
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

/** Appends a new immutable version and bumps the report pointer. */
export async function saveVersion(
  pool: pg.Pool,
  args: {
    report: ReportRow;
    content: ReportContent;
    actor: EventActor;
    /** audit trail: 'editor' for a save, or the version number a revert restored */
    origin: 'editor' | { revertedFrom: number };
  },
): Promise<{ report: ReportRow; version: ReportVersionRow }> {
  return withTransaction(pool, async (client) => {
    // Re-read the pointer under lock so concurrent saves can't collide on version.
    const { rows: lockedRows } = await client.query<ReportRow>(
      'SELECT * FROM reports WHERE id = $1 FOR UPDATE',
      [args.report.id],
    );
    const locked = lockedRows[0]!;
    const nextVersion = locked.current_version + 1;

    const { rows: versionRows } = await client.query<ReportVersionRow>(
      `INSERT INTO report_versions (id, report_id, version, content, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [newUlid(), locked.id, nextVersion, JSON.stringify(args.content), args.actor.actorId ?? null],
    );
    const { rows: reportRows } = await client.query<ReportRow>(
      'UPDATE reports SET current_version = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [nextVersion, locked.id],
    );

    const isRevert = args.origin !== 'editor';
    await recordEvent(client, {
      valuationId: locked.valuation_id,
      type: isRevert ? EVENT_TYPES.reportReverted : EVENT_TYPES.reportSaved,
      actor: args.actor,
      payload: {
        version: nextVersion,
        ...(isRevert ? { restored_version: (args.origin as { revertedFrom: number }).revertedFrom } : {}),
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
