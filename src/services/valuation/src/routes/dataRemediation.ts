import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { describeForUser, InternalServiceError } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import {
  findRerunnableBacksolves,
  listStaleBacksolves,
  listStaleQaReviews,
  REMEDIATION_PAGE_LIMIT,
} from '../repos/dataRemediation.js';
import { findValuationsByIds } from '../repos/valuations.js';
import { findParamsByValuationIds } from '../repos/params.js';
import { buildCalculationInputs, runCalculation } from './calculations.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import type { EventActor } from '../events/record.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';

/**
 * Data remediation (design §7.4, P0-7 and P0-8).
 *
 * One surface hosting both stored-data defects, because they are the same
 * shape: an engine or a check changed, everything computed since is right,
 * everything computed before is wrong in a way nothing surfaces, and the
 * subset that has already been published cannot be quietly corrected.
 *
 * The whole design is "list, then act, and never act on a published opinion".
 * A published 409A is a signed document a client has relied on — for a board
 * grant price, for a tax position. Re-running the engine underneath it and
 * updating the stored figure does not fix that report; it makes the platform
 * disagree with a document that is already out in the world, silently. So the
 * bulk re-run refuses published engagements by construction rather than by a
 * checkbox someone can tick, and the remedy for a published one is a human
 * decision recorded in `methodology_decisions`.
 */

const MAX_RERUN = 25;

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

export function registerDataRemediationRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; engineUrl: string },
): void {
  const requireOps = (req: Parameters<typeof requirePrincipal>[0]): Principal => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Data remediation is operations-only');
    return principal;
  };

  /**
   * Both queues in one response.
   *
   * Together rather than two endpoints because they are read together: the
   * question an operator has is "what stored data is stale", and answering it
   * across two page loads invites treating one of them as the whole answer.
   */
  app.get('/api/v1/admin/data-remediation', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(REMEDIATION_PAGE_LIMIT).default(REMEDIATION_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      throw invalidQuery(parsedQuery.error);
    }
    const { limit } = parsedQuery.data;
    const [backsolves, qaReviews] = await Promise.all([
      listStaleBacksolves(deps.pool, { limit }),
      listStaleQaReviews(deps.pool, { limit }),
    ]);
    return {
      stale_backsolves: {
        rows: backsolves.rows,
        total: backsolves.total,
        published: backsolves.published,
        rerunnable: backsolves.total - backsolves.published,
        truncated: backsolves.truncated,
        page_limit: REMEDIATION_PAGE_LIMIT,
        description:
          'Calculations that took the single-breakpoint backsolve with a live option pool. ' +
          'The stored equity value is low by roughly the pool’s share, and any report rendered ' +
          'from one still says so.',
      },
      stale_qa_reviews: {
        rows: qaReviews.rows,
        total: qaReviews.total,
        published: qaReviews.published,
        truncated: qaReviews.truncated,
        page_limit: REMEDIATION_PAGE_LIMIT,
        description:
          'QA reviews of a Chaffee/Finnerty run that carry no DLOM-range check. The check is a ' +
          'publish gate, and with the DLOM parameter left null the old version did not run at all.',
      },
      max_rerun: MAX_RERUN,
    };
  });

  /**
   * Re-run the affected calculations for unpublished engagements.
   *
   * Every id is re-checked against the live queue rather than trusted from the
   * body: the list the operator was looking at is up to a page load old, and
   * "published since you loaded this" is exactly the race that must not result
   * in a rewritten opinion.
   *
   * Failures are reported per row rather than thrown. One engagement whose
   * params have drifted out of engine tolerance since it was computed must not
   * discard the twenty re-runs that worked.
   */
  app.post('/api/v1/admin/data-remediation/rerun', { preHandler: app.authenticate }, async (req) => {
    const principal = requireOps(req);
    const parsed = z
      .object({ valuation_ids: z.array(z.string()).min(1).max(MAX_RERUN) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      throw invalidBody('Invalid re-run request', parsed.error);
    }

    // Eligibility is resolved against the ids asked for, not against a page of
    // the queue: the list is capped and ordered published-first, so a
    // re-runnable row can sit past the cut and must not be reported missing.
    const requested = parsed.data.valuation_ids.map((raw) => raw.toUpperCase()).filter(isUlid);
    const eligible = await findRerunnableBacksolves(deps.pool, requested);

    /*
     * The engagement and its params for the whole batch, in two reads.
     *
     * Only the eligible ids: an id the queue rejected is answered from
     * `eligible` alone and never reaches the loop body, so fetching it would
     * be work for a row nobody looks at. `MAX_RERUN` is 25, so this replaces
     * up to fifty single-row round trips with two — in front of a loop where
     * each surviving iteration then calls the engine, which is exactly where
     * an operator's wall-clock should be going.
     */
    const eligibleIds = [...eligible];
    const [valuations, params] = await Promise.all([
      findValuationsByIds(deps.pool, eligibleIds),
      findParamsByValuationIds(deps.pool, eligibleIds),
    ]);

    /**
     * `refused` separates the gate from a fault, for the console and the spine
     * (R412). A row the publish gate turned away is this route working; a row
     * the engine dropped is not, and the two were one `failed` tally.
     */
    const results: Array<{ valuation_id: string; ok: boolean; refused?: boolean; error?: string }> = [];
    for (const rawId of parsed.data.valuation_ids) {
      const id = rawId.toUpperCase();
      if (!isUlid(id) || !eligible.has(id)) {
        results.push({
          valuation_id: rawId,
          ok: false,
          // The same gate as `beforePersist` below, asked earlier — so the same
          // word for it. A malformed id is not the gate turning anything away,
          // it is a request this route could not read, and stays a plain
          // failure so `refused` means one thing.
          refused: isUlid(id),
          error: 'Not in the re-runnable queue — it may have published since this list was loaded.',
        });
        continue;
      }
      try {
        const valuation = valuations.get(id);
        const paramsRow = valuation ? (params.get(id) ?? null) : null;
        if (!valuation || !paramsRow) {
          results.push({ valuation_id: id, ok: false, error: 'Valuation or params missing' });
          continue;
        }
        const inputs = await buildCalculationInputs(deps.pool, id, paramsRow, {}, req.log);
        await runCalculation(deps, {
          valuation,
          paramsRow,
          inputs,
          createdBy: principal.id,
          actor: { actorType: 'engine', actorId: principal.id, source: 'engine-wrapper' },
          /*
           * ASKED AGAIN, PER ROW, IN FRONT OF THE WRITE (R411, methodology M4).
           *
           * `findRerunnableBacksolves` above is the publish gate this file's
           * header describes — "the bulk re-run refuses published engagements
           * by construction rather than by a checkbox someone can tick" — and
           * it was asked once, for the whole batch, before any of it ran. What
           * it therefore promised was that nothing was published when the
           * operator pressed the button. `MAX_RERUN` is 25 and each iteration
           * spends an engine round trip with a 30s ceiling, so the batch is
           * minutes long, and the row this loop reaches last was checked at the
           * start of all of them.
           *
           * An engagement that publishes inside that window gets a fresh
           * `succeeded` calculation written under a signed opinion. That row is
           * what `latestCalculation` hands the report summary, the exhibits and
           * the workspace header — so the platform then quotes a different FMV
           * per share than the PDF the client is holding, with nothing on
           * either saying they disagree. It is the one outcome this route's own
           * header says must not happen.
           *
           * The same predicate, re-asked for one id in the window
           * `refuseIfRetiredNow` occupies — after the engine has answered and
           * before the row exists. It re-reads more than the state: a run
           * somebody else re-ran in the meantime is no longer a stale backsolve
           * either, and this row would overwrite their conclusion with one
           * struck from inputs read before it.
           */
          beforePersist: async () => {
            if ((await findRerunnableBacksolves(deps.pool, [id])).has(id)) return;
            throw problems.conflict(
              'This engagement left the re-runnable queue while the batch was running — it has ' +
                'published, been withdrawn, or already been re-run. Nothing was written for it.',
            );
          },
        });
        results.push({ valuation_id: id, ok: true });
      } catch (err) {
        // A 200 body is still a body somebody reads. `err.message` carries the
        // raw upstream detail whenever `opaque` is set, which is the case the
        // flag exists for — see `describeForUser`.
        //
        // The 409 above is ours, word for word, and it is the one refusal an
        // operator can act on: it names why this row was skipped and says
        // nothing was written. Collapsing it into "Re-run failed" beside a
        // genuine engine fault would hide the publish gate doing its job.
        const refused = err instanceof ApiProblem && err.status === 409;
        const message = refused
          ? (err as ApiProblem).detail
          : err instanceof InternalServiceError
            ? describeForUser(err)
            : 'Re-run failed';
        /*
         * THE SAME DISTINCTION IN THE LOG (R412, methodology M11).
         *
         * The branch above draws it for the response body and says why —
         * "collapsing it into 'Re-run failed' beside a genuine engine fault
         * would hide the publish gate doing its job" — and then wrote one
         * `warn` reading 'remediation re-run failed', with the refusal's own
         * error attached, for both.
         *
         * The gate firing is not a failure. It is this route's central
         * guarantee working: an engagement published while the batch was
         * running, and nothing was written under its signed opinion. Filed as a
         * warning it reads as an engine fault an operator should chase, and the
         * one signal that a publish really did race a re-run — which is a fact
         * about how this console is being used, and the thing a later round
         * would want to know before widening the batch — is buried in a
         * vocabulary that means the opposite.
         *
         * `info`, because nothing is wrong and nothing needs doing; its own
         * `event` so it can be counted; and no `err`, because a refusal this
         * route authored is not an error anybody has to read a stack for.
         */
        if (refused) {
          req.log.info(
            { event: 'remediation_rerun_refused', valuationId: id },
            'remediation re-run refused: the engagement left the re-runnable queue mid-batch',
          );
        } else {
          req.log.warn({ err, valuationId: id }, 'remediation re-run failed');
        }
        results.push({ valuation_id: id, ok: false, refused, error: message });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    /*
     * `refused` on the spine row too, and not folded into `failed`.
     *
     * This row is the durable record of an operator re-running stored
     * conclusions in bulk, and "22 succeeded, 3 failed" says the engine dropped
     * three. If those three were the publish gate, the record of the one thing
     * this console must never do — and did not do — is a number that says
     * something went wrong instead. Additive: `failed` still counts every row
     * that did not run, so nothing reading the old two fields changes meaning.
     */
    const refused = results.filter((r) => r.refused).length;
    await recordAdminEvent(deps.pool, {
      type: 'data_remediation_rerun',
      actor: actorFor(principal),
      subjectType: 'data_remediation',
      subjectLabel: 'stale_backsolve',
      payload: { requested: results.length, succeeded, failed: results.length - succeeded, refused },
    });
    return { results, succeeded, failed: results.length - succeeded, refused };
  });
}
