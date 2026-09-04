import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { diffRecords } from '../domain/auditTrail.js';
import { INTAKE_EVENT_TYPES, narrowIntakeAnswers } from '../domain/intake.js';

export interface QuestionnaireRow {
  id: string;
  valuation_id: string;
  answers: Record<string, unknown>;
  submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function findQuestionnaire(
  pool: pg.Pool,
  valuationId: string,
): Promise<QuestionnaireRow | null> {
  const { rows } = await pool.query<QuestionnaireRow>(
    'SELECT * FROM intake_questionnaires WHERE valuation_id = $1',
    [valuationId],
  );
  return rows[0] ?? null;
}

/**
 * Filter incoming answers to known field keys — and to the value shapes those
 * fields can hold — before persisting. Shared with the anonymous portal so the
 * two questionnaires cannot disagree about what a stored answer may be.
 */
const sanitizeAnswers = narrowIntakeAnswers;

/**
 * Merge-save the questionnaire answers (create on first save). Answers are
 * shallow-merged so a wizard can save one section at a time without clobbering
 * the others.
 */
export async function saveQuestionnaire(
  pool: pg.Pool,
  valuationId: string,
  answers: Record<string, unknown>,
  actor: EventActor,
  // Kind-specific questionnaires (domain/intakeKinds.ts) pass their own key
  // set; the default is the 409A form's, matching the schema default served.
  keys?: ReadonlySet<string>,
): Promise<QuestionnaireRow> {
  const clean = sanitizeAnswers(answers, keys);
  return withTransaction(pool, async (client) => {
    // Read first, so the event can say what the answer *was*. `intake_saved` is
    // a client-visible event and the answers it records become statements of
    // fact in the deliverable — "10,000,000 shares outstanding, per the
    // company". A trail that lists the section's field names on every save can
    // say the client saved that section eleven times and nothing about which of
    // the eleven changed the share count.
    const { rows: locked } = await client.query<QuestionnaireRow>(
      'SELECT * FROM intake_questionnaires WHERE valuation_id = $1 FOR UPDATE',
      [valuationId],
    );
    const before = (locked[0]?.answers ?? {}) as Record<string, unknown>;
    // `narrowIntakeAnswers` admits string, number, boolean and null and nothing
    // else, so `===` is a complete comparison here — no array or object answer
    // can reach this and compare unequal to itself.
    const changes = diffRecords(before, clean, Object.keys(clean));

    const { rows } = await client.query<QuestionnaireRow>(
      `INSERT INTO intake_questionnaires (id, valuation_id, answers)
       VALUES ($1, $2, $3)
       ON CONFLICT (valuation_id) DO UPDATE SET
         answers = intake_questionnaires.answers || EXCLUDED.answers,
         updated_at = now()
       RETURNING *`,
      [newUlid(), valuationId, JSON.stringify(clean)],
    );
    // A save that answered nothing new is not an edit. The row is still written
    // — the wizard's `updated_at` is what its progress display reads — but the
    // trail is left alone rather than collecting a row an auditor must open to
    // discover is empty.
    if (Object.keys(changes).length > 0) {
      await recordEvent(client, {
        valuationId,
        type: INTAKE_EVENT_TYPES.saved,
        actor,
        // `fields` beside `changes` because the audit reader understands both
        // and every event already on a live engagement carries only the former.
        payload: { changes, fields: Object.keys(changes) },
      });
    }
    return rows[0]!;
  });
}

/**
 * Stamp the submission — once (R416, methodology M3).
 *
 * The UPDATE was unconditional and the event was written beside it whatever it
 * matched, so pressing Submit twice re-dated the submission and put a second
 * `intake_submitted` on the spine. Neither half is cosmetic. `submitted_at` is
 * *when the client finished* — it is what the questionnaire endpoint answers
 * with and what an engagement created by `convertIntakeLink` carries over from
 * the intake link — and `intake_submitted` is a client-visible event
 * (`domain/auditTrail.ts`) on a log whose 0001 trigger will not let a row be
 * taken back off. An engagement converted from a portal link already holds one,
 * so a later press added a second submission that never happened.
 *
 * And a second press is the ordinary case, not an exotic one — the door is open
 * to the client as well as to ops (`canEditIntake`), the request takes a
 * moment, and the button does not visibly change. The portal half of this same
 * questionnaire has said so in `submitIntakeLink` since it was written: stamp
 * only where `submitted_at` is still null, and answer the repeat with the
 * standing row rather than an error, because "a client who submitted on Friday
 * and typed on Monday" must not be told their answers are gone. This is that
 * rule at the authenticated door, which never had it.
 *
 * Null when there is no questionnaire row at all. That was `rows[0]!` — an
 * assertion covering a case the route reaches by its own arithmetic, since
 * `computeCompletion` calls a form with no required fields ready with nothing
 * saved — so the reward for submitting one was a bare 500.
 */
export async function submitQuestionnaire(
  pool: pg.Pool,
  valuationId: string,
  actor: EventActor,
): Promise<QuestionnaireRow | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<QuestionnaireRow>(
      `UPDATE intake_questionnaires SET submitted_at = now(), updated_at = now()
       WHERE valuation_id = $1 AND submitted_at IS NULL RETURNING *`,
      [valuationId],
    );
    const submitted = rows[0];
    if (!submitted) {
      // Already in, or never started. The row itself tells the caller which —
      // `submitted_at` is on it — and neither is a state to write an event
      // about.
      const { rows: live } = await client.query<QuestionnaireRow>(
        'SELECT * FROM intake_questionnaires WHERE valuation_id = $1',
        [valuationId],
      );
      return live[0] ?? null;
    }
    await recordEvent(client, {
      valuationId,
      type: INTAKE_EVENT_TYPES.submitted,
      actor,
      payload: {},
    });
    return submitted;
  });
}
