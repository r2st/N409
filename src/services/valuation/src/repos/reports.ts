import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction, type Queryable } from '../db/pool.js';
import { EVENT_TYPES } from '../domain/valuation.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { lockPublishGate } from './publishLock.js';
import {
  DELIVERED_REPORT_STATES,
  reportStatusFor,
  type ReportContent,
  type ReportStatus,
} from '../domain/report.js';
import type { ValuationState } from '../domain/valuation.js';

export interface ReportRow {
  id: string;
  valuation_id: string;
  template_version: string;
  current_version: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * The row as a caller may show it: the stored columns, plus the status derived
 * from the engagement.
 *
 * `status` is deliberately absent from {@link ReportRow} above. The column
 * exists — `SELECT *` still returns it — and it has held `'draft'` on every
 * row this system has ever created, because nothing writes it; see
 * `reportStatusFor`. Leaving it off the type is what makes the compiler refuse
 * the stale reading: a route that wants to tell somebody what the report is at
 * has to say which engagement it is asking about.
 */
export type ReportView = ReportRow & { status: ReportStatus };

/** The row plus its derived status, for anything leaving the service. */
export function reportView(report: ReportRow, state: ValuationState): ReportView {
  return { ...report, status: reportStatusFor(state) };
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

/**
 * A stored version without its bytes — the body, plus whether a render exists.
 *
 * The reason this is the default reading and `getVersionPdf` is the exception:
 * `report_versions.pdf` holds a whole 409A deliverable, three quarters of a
 * megabyte for an ordinary one and past a megabyte for a large cap table, and
 * `SELECT *` shipped it to the valuation process on every read of the *body*.
 * Ten of the twelve readings never wanted it. Two only wanted to know whether
 * it was there.
 *
 * Measured on a stored 723kB render, over a local socket: 3.75ms for the row
 * with its bytes against 0.25ms without — fifteen times, before counting the
 * megabyte-and-a-half of hex the driver decodes into a Buffer that is then
 * dropped. The heaviest of those readings is the report editor's own load,
 * which happens every time an analyst opens the report tab.
 */
export type ReportVersionContent = Omit<ReportVersionRow, 'pdf'> & { has_pdf: boolean };

const VERSION_CONTENT_COLUMNS =
  'id, report_id, version, content, rendered_at, created_by, created_at, pdf IS NOT NULL AS has_pdf';

/**
 * When the body a report currently points at was written.
 *
 * One column of one version row, because the publish gate asks nothing else of
 * it: `assertPublishGate` compares this instant against the analyst's signature
 * to decide whether the signature is about the document being published. Going
 * through {@link getVersionContent} for it would pull the whole stored body —
 * every chapter of a 409A — onto a connection that is holding the publish lock.
 */
export async function versionWrittenAt(
  db: Queryable,
  reportId: string,
  version: number,
): Promise<Date | null> {
  const { rows } = await db.query<{ created_at: Date }>(
    'SELECT created_at FROM report_versions WHERE report_id = $1 AND version = $2',
    [reportId, version],
  );
  return rows[0]?.created_at ?? null;
}

export async function getVersionContent(
  pool: pg.Pool,
  reportId: string,
  version: number,
): Promise<ReportVersionContent | null> {
  const { rows } = await pool.query<ReportVersionContent>(
    `SELECT ${VERSION_CONTENT_COLUMNS} FROM report_versions WHERE report_id = $1 AND version = $2`,
    [reportId, version],
  );
  return rows[0] ?? null;
}

/**
 * The stored bytes of one version, and nothing else.
 *
 * Deliberately the only way to them, and deliberately narrow: `deliverablePdf`
 * is its one caller, because whether a reader gets the stored deliverable or a
 * freshly stamped draft is a decision that lives in exactly one place (see the
 * note there, and `reportPdfDoorCensus`). A route that reaches these bytes any
 * other way is a route that can hand an auditor an unmarked draft.
 */
export async function getVersionPdf(
  pool: pg.Pool,
  reportId: string,
  version: number,
): Promise<Buffer | null> {
  const { rows } = await pool.query<{ pdf: Buffer | null }>(
    'SELECT pdf FROM report_versions WHERE report_id = $1 AND version = $2',
    [reportId, version],
  );
  return rows[0]?.pdf ?? null;
}

/**
 * The newest version of this report that carries stored bytes — the one that
 * has actually been delivered — or null when nothing has been rendered yet.
 *
 * `reports.current_version` is the newest body an analyst has *written*, and on
 * a published engagement the two are not the same question. Saving a report
 * version is guarded by nothing but `refuseIfRetired`, on purpose, so a
 * published engagement can hold a body newer than the one it issued.
 *
 * The evidence bundle and the partner API both already ask this question — each
 * walks the version list for the first row with `has_pdf` — and only the
 * session download asked for `current_version` instead. This is that question
 * as one statement, so the three doors agree about which version is the
 * deliverable.
 */
export async function latestDeliveredVersion(pool: pg.Pool, reportId: string): Promise<number | null> {
  return latestRenderedVersion(pool, reportId);
}

/**
 * The newest version holding stored bytes, on the pool or inside a
 * transaction — the publish gate asks it under the row lock its write takes,
 * which is why this takes a `Queryable` where {@link latestDeliveredVersion}
 * took the pool. Same statement; the name says which question is being asked.
 */
export async function latestRenderedVersion(db: Queryable, reportId: string): Promise<number | null> {
  const { rows } = await db.query<{ version: number | null }>(
    'SELECT max(version) AS version FROM report_versions WHERE report_id = $1 AND pdf IS NOT NULL',
    [reportId],
  );
  return rows[0]?.version ?? null;
}

/**
 * Which version of this report an outside reader is owed, given the engagement's
 * state — the delivered one where there is one, the current body otherwise.
 *
 * THE QUESTION, RATHER THAN A FOURTH ANSWER TO IT (round 327, methodology M4).
 *
 * R319 pinned the session PDF download to {@link latestDeliveredVersion} and
 * named three doors that had to agree about the deliverable: that download, the
 * evidence bundle and the partner API. It counted the doors that serve *bytes*.
 * The auditor portal serves the same document as content — it is the page an
 * outside auditor is sent a link to, and it titles what it shows with
 * `reportStatusFor(state)`, which on a published engagement reads `published` —
 * and it asked for `current_version`. So the defect R319 closed on the PDF was
 * still reachable, by the reader it most concerns: an analyst saves a body after
 * publication, and the auditor verifying the 409A is shown that body as the
 * issued report. Nothing about it went through the publish gate — it carries no
 * signature covering it (rule 4) and no QA review of it (rule 3) — and the
 * portal does not so much as say the version number, so there is nothing on the
 * page to notice it by.
 *
 * `GET /report` is the same door for the client and the partner: the report tab
 * renders whatever content it is handed, so a published engagement showed the
 * edit on screen while `report.pdf` beside it delivered the signed version.
 *
 * Asked here, once, so a fifth reader inherits the answer rather than choosing
 * one. Draft states are unchanged and deliberately so: a draft renders fresh on
 * every read, which is the whole point of the stamp.
 */
export async function deliverableVersion(
  pool: pg.Pool,
  report: Pick<ReportRow, 'id' | 'current_version'>,
  state: ValuationState,
): Promise<number> {
  if (!DELIVERED_REPORT_STATES.has(state)) return report.current_version;
  // Null where a published engagement never rendered anything. Its current body
  // is then the only body there is, and the lazy render in `report.pdf` is what
  // issues the first deliverable — see `reportPostPublishEdit.test.ts`.
  return (await latestDeliveredVersion(pool, report.id)) ?? report.current_version;
}

/** Version list for the history panel — content itself is fetched per version. */
export type ReportVersionSummary = Omit<ReportVersionRow, 'content' | 'pdf'> & { has_pdf: boolean };

/**
 * The cap on one report's version history.
 *
 * `report_versions` gains a row on every save of the report body — a
 * self-serve write path with no maximum — so the history of a report that has
 * been through a long review is as long as the review was, and this read had
 * no bound of any kind. Four callers take it, and two of them are the evidence
 * bundle and the partner API, where the answer is assembled alongside every
 * other artefact of the engagement.
 *
 * The cut takes the *newest* end. Every caller either renders the list newest
 * first or does `versions.find(v => v.has_pdf)` to reach the latest rendered
 * PDF, and both stay correct under the cap for the same reason: what is
 * dropped is the oldest end of the history, never the current state of the
 * report.
 *
 * `truncated` rides back with it rather than being inferred from the length,
 * because an evidence bundle that quietly stops is a record an auditor reads
 * as complete. It is the same shape and the same reason as
 * `COMMENT_PAGE_LIMIT`.
 */
export const REPORT_VERSION_PAGE_LIMIT = 500;

export async function listVersions(
  pool: pg.Pool,
  reportId: string,
  opts: { limit?: number } = {},
): Promise<{ versions: ReportVersionSummary[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? REPORT_VERSION_PAGE_LIMIT, 1), REPORT_VERSION_PAGE_LIMIT);
  const { rows } = await pool.query(
    `SELECT id, report_id, version, rendered_at, created_by, created_at, (pdf IS NOT NULL) AS has_pdf
     FROM report_versions WHERE report_id = $1 ORDER BY version DESC LIMIT $2`,
    [reportId, limit + 1],
  );
  const all = rows as ReportVersionSummary[];
  return { versions: all.slice(0, limit), truncated: all.length > limit };
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

/**
 * Stores the rendered PDF on its version row and records the event.
 *
 * Returns nothing, and that is the fix rather than a tidy-up (R417, methodology
 * M8). Both statements below used to carry the deliverable back to this process
 * for no reader at all — see the two comments inside — so a signature that hands
 * a `ReportVersionRow` out is a standing invitation to put the bytes back on the
 * wire. The route's one call site has always been a bare `await`.
 */
export async function storeRenderedPdf(
  pool: pg.Pool,
  args: { report: ReportRow; version: number; pdf: Buffer; actor: EventActor },
): Promise<void> {
  return withTransaction(pool, async (client) => {
    /*
     * The delivered-version check, re-asked at the moment of the write.
     *
     * `POST /report/render` already refuses to re-render a delivered version,
     * and the comment over that refusal states the stake: the exhibits are
     * derived at render time from the latest calculation, so putting new bytes
     * under a version number the client already holds means a different
     * document, with a different concluded value, in board minutes and an
     * auditor's file, indistinguishable from the outside.
     *
     * That check reads `valuations.state` at the top of the request, and this
     * is the bottom of it. In between is the render — the summary and exhibit
     * queries, a branding lookup that may fetch a white-label logo over the
     * network, and a delegated call to the report unit whose budget is measured
     * in seconds. Publication in another tab is one PATCH. So the request that
     * passed the guard is exactly the request that overwrites the delivered
     * bytes, and the guard reports a safety it stopped being able to provide
     * the moment it returned.
     *
     * Asked here instead — under the row lock, against the state as it stands —
     * the answer cannot go stale between the asking and the write. `FOR UPDATE
     * OF v` locks the version alone: the valuation is read for its state and
     * locking it would put a report render in the way of every ordinary edit of
     * the engagement.
     *
     * The condition is "delivered *and* already has bytes", exactly as the
     * route's is. An engagement published before anything was rendered still
     * has to be able to produce its deliverable, and that first render replaces
     * nothing.
     */
    /*
     * `pdf IS NOT NULL`, not `pdf` — the question is whether bytes are there.
     *
     * This is the rule `ReportVersionContent` states forty lines up, applied to
     * the one read in this file that had not taken it: a stored render is three
     * quarters of a megabyte for an ordinary report and past a megabyte for a
     * large cap table, and selecting it here detoasted all of it, hex-decoded it
     * into a Buffer and compared it against null. Measured on a 723 kB render:
     * 3.12 ms against 0.22 ms, and 740 kB of short-lived Buffer, inside the
     * transaction that holds this version's row lock for the rest of the write.
     */
    const { rows: locked } = await client.query<{ has_pdf: boolean; state: string }>(
      `SELECT v.pdf IS NOT NULL AS has_pdf, val.state
         FROM report_versions v
         JOIN reports r ON r.id = v.report_id
         JOIN valuations val ON val.id = r.valuation_id
        WHERE v.report_id = $1 AND v.version = $2
        FOR UPDATE OF v`,
      [args.report.id, args.version],
    );
    const before = locked[0];
    if (before && before.has_pdf && DELIVERED_REPORT_STATES.has(before.state)) {
      throw problems.conflict(
        `Version ${args.version} has already been delivered — this render finished after the ` +
          `engagement was published and has not been stored. Save a new version to publish ` +
          `revised figures.`,
      );
    }
    /*
     * `RETURNING version` and not `RETURNING *`.
     *
     * The row is wanted for one thing — whether the UPDATE matched anything, so
     * a missing version is a throw rather than a silent no-op — and `*` answered
     * that by sending back the deliverable this statement had just carried *up*,
     * plus the whole authored body beside it. Nothing reads either: the route's
     * call site is `await storeRenderedPdf(...)` with no assignment, and always
     * has been. 5.70 ms against 3.70 on a 723 kB render, and another 740 kB of
     * Buffer plus a re-parse of the body document, on every render.
     */
    const { rows } = await client.query<{ version: number }>(
      `UPDATE report_versions SET pdf = $1, rendered_at = now()
       WHERE report_id = $2 AND version = $3
       RETURNING version`,
      [args.pdf, args.report.id, args.version],
    );
    if (!rows[0]) throw new Error(`report version ${args.version} not found for report ${args.report.id}`);
    await recordEvent(client, {
      valuationId: args.report.valuation_id,
      type: EVENT_TYPES.reportRendered,
      actor: args.actor,
      payload: { version: args.version, size_bytes: args.pdf.length },
    });
  });
}
