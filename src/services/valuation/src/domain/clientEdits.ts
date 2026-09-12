import { problems } from '@n409/shared';
import type { ValuationState } from './valuation.js';

/**
 * When the client may still correct an engagement's own details.
 *
 * The line is drawn where the deliverable starts being written: once a file
 * is in `review` an analyst is working from these values, and a company name
 * that changes underneath them appears in a report nobody re-read. Before
 * that it is still a submission. The three stopped states are out for the
 * same reason a stopped file takes no other client write — a restart is the
 * door back, and it is an analyst's.
 *
 * The partner API drew this line when it gained `PUT /valuations/{id}`, as a
 * constant of its own, and the console's `PATCH /valuations/:id` — the same
 * owner, the same three fields, over a session instead of a key — never
 * asked (R449). A client could rename the company on a published 409A whose
 * signatures were taken over the old name, and a render that had not yet
 * happened (the lazy render on first download issues the current body) would
 * carry the new one under the old certification page.
 *
 * One set, read by both doors. Ops are not the audience: an analyst
 * correcting a label after review is the ordinary path and re-renders.
 */
export const CLIENT_EDITABLE_STATES: ReadonlySet<ValuationState> = new Set<ValuationState>([
  'pending',
  'started',
  'onboarding_completed',
  'user_finished',
  'completed',
  'paid',
]);

export function clientMayEdit(valuation: { state: string }): boolean {
  return CLIENT_EDITABLE_STATES.has(valuation.state as ValuationState);
}

/**
 * The refusal, in one sentence for both doors: the state that closed the
 * edit, why, and — from the caller — who to ask instead.
 */
export function refuseIfClientEditClosed(valuation: { state: string }, remedy: string): void {
  if (clientMayEdit(valuation)) return;
  throw problems.conflict(
    `This valuation is '${valuation.state}' — its details are being written into the deliverable ` +
      `and are no longer editable by the client. ${remedy}`,
  );
}
