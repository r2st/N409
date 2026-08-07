import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
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
): Promise<QuestionnaireRow> {
  const clean = sanitizeAnswers(answers);
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<QuestionnaireRow>(
      `INSERT INTO intake_questionnaires (id, valuation_id, answers)
       VALUES ($1, $2, $3)
       ON CONFLICT (valuation_id) DO UPDATE SET
         answers = intake_questionnaires.answers || EXCLUDED.answers,
         updated_at = now()
       RETURNING *`,
      [newUlid(), valuationId, JSON.stringify(clean)],
    );
    await recordEvent(client, {
      valuationId,
      type: INTAKE_EVENT_TYPES.saved,
      actor,
      payload: { fields: Object.keys(clean) },
    });
    return rows[0]!;
  });
}

export async function submitQuestionnaire(
  pool: pg.Pool,
  valuationId: string,
  actor: EventActor,
): Promise<QuestionnaireRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<QuestionnaireRow>(
      `UPDATE intake_questionnaires SET submitted_at = now(), updated_at = now()
       WHERE valuation_id = $1 RETURNING *`,
      [valuationId],
    );
    await recordEvent(client, {
      valuationId,
      type: INTAKE_EVENT_TYPES.submitted,
      actor,
      payload: {},
    });
    return rows[0]!;
  });
}
