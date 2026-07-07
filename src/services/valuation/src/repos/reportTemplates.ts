import type pg from 'pg';
import { newUlid } from '@n409/shared';
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

export async function listTemplates(
  pool: pg.Pool,
  filters: { name?: string; kind?: ValuationKind; status?: ReportTemplateStatus } = {},
): Promise<ReportTemplateRow[]> {
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
  const { rows } = await pool.query<ReportTemplateRow>(
    `SELECT * FROM report_templates ${whereSql} ORDER BY name ASC, version DESC`,
    params,
  );
  return rows;
}

export async function findTemplateById(pool: pg.Pool, id: string): Promise<ReportTemplateRow | null> {
  const { rows } = await pool.query<ReportTemplateRow>('SELECT * FROM report_templates WHERE id = $1', [id]);
  return rows[0] ?? null;
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
    // Serialize per-name so two concurrent creates can't claim the same version.
    const { rows: last } = await client.query<{ version: number }>(
      'SELECT version FROM report_templates WHERE name = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE',
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
    const { rows: target } = await client.query<ReportTemplateRow>(
      'SELECT * FROM report_templates WHERE id = $1 FOR UPDATE',
      [id],
    );
    const template = target[0];
    if (!template || template.status === 'active') return template ?? null;
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

export async function archiveTemplate(pool: pg.Pool, id: string): Promise<ReportTemplateRow | null> {
  const { rows } = await pool.query<ReportTemplateRow>(
    `UPDATE report_templates SET status = 'archived', updated_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}
