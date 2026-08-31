import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, logFailure, problems } from '@n409/shared';
import { canManageUsers } from '../auth/rbac.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById, invalidateValuation } from '../repos/valuations.js';
import { findUserById } from '../repos/users.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import type { AdminEventType } from '../domain/auditTrail.js';
import {
  isDueForArchival,
  RETENTION_DATA_TYPES,
  RETENTION_ENFORCEMENT,
  type RetentionDataType,
} from '../domain/retention.js';
import { restoreValuations, retireValuations } from '../repos/valuationPurge.js';
import { firePartnerWebhooksForRetirement } from '../hooks/partnerWebhooks.js';
import {
  findArchivableValuations,
  HOLD_PAGE_LIMIT,
  isValuationFrozen,
  listActions,
  listHolds,
  listPolicies,
  listRetiredValuations,
  markValuationsArchived,
  placeHold,
  purgeExpiredOutbox,
  recordActions,
  releaseHold,
  upsertPolicy,
  type RetentionPolicyRow,
} from '../repos/retention.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { withTransaction } from '../db/pool.js';

/**
 * Data retention + legal hold administration (feature 10). Admin-only. The
 * automated archival sweep (runRetentionSweep) archives records past their
 * policy's age unless a legal hold freezes them, and records every action.
 */

const PolicyBody = z.object({
  archive_after_days: z.number().int().min(1).max(36500).nullable(),
  retention_days: z.number().int().min(1).max(36500).nullable(),
  enabled: z.boolean(),
});
const HoldBody = z.object({
  scope: z.enum(['global', 'valuation', 'user']),
  reference_id: z.string().nullable().optional(),
  reason: z.string().trim().min(1).max(1000),
});

/**
 * Resolve the aggregate a non-global hold names, refusing anything that does
 * not exist.
 *
 * A hold is the control that stops a sweep deleting evidence someone is under a
 * legal obligation to keep, and `legal_holds.reference_id` carries no foreign
 * key — it cannot, because the column is polymorphic over valuations and users.
 * So nothing downstream ever notices a bad reference: `findArchivableValuations`
 * compares it against `v.id`/`v.user_id`, no row matches, and the sweep archives
 * the very records the hold was placed to freeze. The admin saw a 201 and a hold
 * listed as active. A typo'd id has to fail here, where someone is looking, and
 * not months later in a sweep nobody is.
 *
 * The malformed case was louder and no better: `reference_id` is the `ulid`
 * domain, so a non-ULID string reached Postgres and came back a 500 — the
 * generic one, with nothing said about which field was wrong.
 */
async function assertHoldTarget(
  pool: pg.Pool,
  scope: 'valuation' | 'user',
  referenceId: string,
): Promise<void> {
  if (!isUlid(referenceId)) {
    throw problems.unprocessable(`reference_id is not a valid id for a ${scope} hold`);
  }
  const found =
    scope === 'valuation'
      ? await findValuationById(pool, referenceId)
      : await findUserById(pool, referenceId);
  if (!found) throw problems.unprocessable(`No ${scope} exists with that reference_id`);
}

export interface SweepResult {
  archived: number;
  skipped_hold: number;
  /** Outbox rows deleted under the `email_outbox` policy. */
  purged: number;
}

/**
 * The `email_outbox` half of the sweep: delete correspondence past its policy.
 *
 * Split out rather than inlined because it is the destructive one, and because
 * its guard is different in kind from the archival guard below. Archival is
 * reversible and is driven by `archive_after_days`; this is not reversible and
 * is driven by `retention_days`, so it refuses to act on anything less than an
 * explicit, enabled number. A policy with `retention_days` null keeps the mail
 * forever, which is what the column has always meant and what every deployment
 * has today.
 *
 * `email_delivery_events` cascades from the row, so the provider's bounce and
 * open ledger for a message goes with the message rather than being left
 * pointing at nothing.
 *
 * Recorded in the decision log per row, like the archivals: a delete with no
 * record of who set the policy that caused it is exactly the gap the log
 * exists to close. `skipped_hold` is recorded once for the pass rather than per
 * frozen row — the rows are not deleted, so there is no per-row event to
 * anchor, and the count is what an operator needs to see.
 */
async function sweepOutbox(
  pool: pg.Pool,
  policies: RetentionPolicyRow[],
  opts: { limit?: number },
): Promise<{ purged: number; skippedHold: number }> {
  const policy = policies.find((p) => p.data_type === 'email_outbox');
  if (!policy || !policy.enabled || policy.retention_days === null) {
    return { purged: 0, skippedHold: 0 };
  }
  // Read out before the closure: the narrowing above is of a mutable property.
  const retentionDays = policy.retention_days;
  /*
   * The delete and the record of it, in one transaction.
   *
   * The archival half below had the same pair on the pool and it was already
   * bad there; here it is worse, because this half is the one the comment above
   * calls "not reversible". Five thousand messages — recipients, subjects,
   * bodies — went, and the INSERT that says which ones and under whose policy
   * then failed: a statement timeout on a five-thousand-row VALUES list, a
   * deadlock, a disk that filled. There is nothing to re-derive the list from
   * afterwards, because the rows it named are gone.
   *
   * Together, both or neither. A failed pass deletes nothing and the next tick
   * takes the same batch again, which is exactly what the batch cap already
   * assumes: the backlog drains over successive ticks.
   */
  return withTransaction(pool, async (client) => {
    const { ids, skippedHold } = await purgeExpiredOutbox(client, retentionDays, opts.limit);
    await recordActions(client, [
      ...ids.map((id) => ({
        dataType: 'email_outbox',
        action: 'purged' as const,
        referenceId: id,
        detail: { retention_days: retentionDays },
      })),
      ...(skippedHold > 0
        ? [
            {
              dataType: 'email_outbox',
              action: 'skipped_hold' as const,
              referenceId: null,
              detail: { count: skippedHold, retention_days: retentionDays },
            },
          ]
        : []),
    ]);
    return { purged: ids.length, skippedHold };
  });
}

/**
 * Run the sweep once.
 *
 * Two policies are enforced: `email_outbox` deletes correspondence past its
 * `retention_days`, and `valuation` archives engagements past its
 * `archive_after_days`. Both skip anything an active legal hold covers, and
 * every decision is logged to `retention_actions`.
 *
 * The other three data types are settable and inert by decision, not by
 * omission — `RETENTION_ENFORCEMENT` in domain/retention.ts says which is
 * which and why, the policies endpoint serves it so the console can show it,
 * and `retentionEnforcement.test.ts` holds this function against it. Adding a
 * branch here without moving the declaration, or the reverse, fails that test.
 */
export async function runRetentionSweep(
  pool: pg.Pool,
  opts: { limit?: number; log?: FastifyBaseLogger } = {},
): Promise<SweepResult> {
  const result: SweepResult = { archived: 0, skipped_hold: 0, purged: 0 };
  const policies = await listPolicies(pool);

  /*
   * The outbox first, and unconditionally on the valuation policy. These are
   * two independent policies and the archival branch below returns early when
   * its own is off — which, before this, meant an operator who enabled only
   * `email_outbox` had enabled nothing at all, twice over.
   *
   * Independent in failure too, which they were not: a throw here returned
   * before the archival pass, so an outbox policy that could not be enforced —
   * a batch that keeps timing out, a disk that keeps filling — silently stopped
   * the *valuation* policy being enforced as well, on every tick, for as long
   * as the first one stayed broken. Two compliance obligations, one of them
   * quietly off because the other is.
   *
   * Held rather than swallowed. The pass genuinely failed and the scheduler's
   * alerting is what says so, so the error is re-raised once the second policy
   * has had its turn: the archival lands, and the run is still reported as the
   * failure it was. Nothing here reports partial success, which is the shape
   * this codebase keeps finding on the other side of a catch.
   */
  let outboxFailure: unknown = null;
  const outbox = await sweepOutbox(pool, policies, opts).catch((err: unknown) => {
    outboxFailure = err;
    return { purged: 0, skippedHold: 0 };
  });
  result.purged = outbox.purged;
  result.skipped_hold += outbox.skippedHold;

  /** Re-raise the held outbox failure, once the archival pass has run. */
  const finish = (r: SweepResult): SweepResult => {
    if (outboxFailure !== null) throw outboxFailure;
    return r;
  };

  /*
   * From here to the end, inside a catch that answers one question the hold
   * above left open: what says the outbox pass failed, when the archival pass
   * fails too?
   *
   * `finish` is the only place `outboxFailure` is re-raised, and everything
   * between the catch and it can throw on its own account —
   * `findArchivableValuations`, the archival transaction, the webhook fan-out.
   * When one of them did, its error propagated and the held one went out of
   * scope unmentioned: an irreversible purge that could not run, on a
   * compliance obligation, with nothing anywhere saying so. The scheduler
   * reports the failure it is given and it was only ever given the second one.
   *
   * `logFailure` rather than `logUnretried`: the next tick genuinely does take
   * this batch again, so a transient cause is a `warn` and only a permanent one
   * is worth waking somebody for. Written only when the failure is about to be
   * lost — the ordinary path still re-raises it and is still reported once, by
   * the scheduler, rather than twice.
   *
   * Conditional on a logger because `opts.log` is optional and there is
   * genuinely nowhere else to put it; both production callers — the six-hourly
   * tick in `index.ts` and `POST /retention/sweep` — pass `app.log`.
   */
  try {
    const valPolicy = policies.find((p) => p.data_type === 'valuation');
    if (!valPolicy || !valPolicy.enabled || valPolicy.archive_after_days === null) return finish(result);

    const candidates = await findArchivableValuations(pool, valPolicy.archive_after_days, opts.limit ?? 500);
    const frozen = candidates.filter((c) => c.frozen);

    /*
     * The archival and its record of itself, in one transaction — and two
     * statements for the whole pass, not two per candidate.
     * `findArchivableValuations` returns up to 500 rows with the hold flag
     * already computed, and the loop this replaced spent an UPDATE and an INSERT
     * on each of them in turn: around a thousand sequential round trips to say
     * the same two things.
     *
     * They were two statements on the pool, and the second one failing was the
     * expensive half of the pair. `findArchivableValuations` selects on
     * `archived_at IS NULL`, so a row this UPDATE committed is a row no later
     * sweep will look at again: an INSERT that lost a deadlock, or ran past the
     * statement timeout on a five-hundred-row batch, left those engagements
     * archived for ever with nothing in `retention_actions` saying it happened —
     * and `retention_actions` is the evidence the storage-limitation policy is
     * being enforced, which is the whole point of writing it. The throw also
     * skipped `firePartnerWebhooksForRetirement` below, so the partners whose
     * engagements had just been retired were never told, on a surface where
     * "nothing retries a retirement announcement" is already the known hazard.
     *
     * Together, both or neither: a failed pass leaves every candidate live and
     * the next tick, six hours later, does the whole batch again. That is the
     * spine's own standing rule — an event is written in the same transaction as
     * the change it describes — applied to the one governance log that was
     * outside it.
     *
     * Logged from `archived` rather than from the input list, as before: a
     * candidate a concurrent sweep took first is absent from `RETURNING` and is
     * therefore neither counted nor logged here.
     *
     * A pass with no candidate at all — the ordinary tick on a settled
     * deployment — has nothing to say and so opens no connection to say it in.
     */
    const archived =
      candidates.length === 0
        ? []
        : await withTransaction(pool, async (client) => {
            const taken = await markValuationsArchived(
              client,
              candidates.filter((c) => !c.frozen).map((c) => c.id),
            );
            await recordActions(client, [
              ...frozen.map((c) => ({
                dataType: 'valuation',
                action: 'skipped_hold' as const,
                referenceId: c.id,
              })),
              ...taken.map((id) => ({
                dataType: 'valuation',
                action: 'archived' as const,
                referenceId: id,
                detail: { archive_after_days: valPolicy.archive_after_days },
              })),
            ]);
            return taken;
          });
    // Again, after the COMMIT. `markValuationsArchived` invalidates as it goes,
    // which inside a transaction is a moment before the rows actually change —
    // long enough for a concurrent read to have put the pre-archive row back.
    for (const id of archived) invalidateValuation(id);

    // After the log, and never allowed to fail the sweep: `firePartnerWebhooks`
    // swallows and logs a dispatch failure per webhook, and the batch shape is
    // what keeps this to one query rather than one per archived row.
    await firePartnerWebhooksForRetirement({ pool, log: opts.log }, archived);

    result.archived = archived.length;
    // `+=`: the outbox pass above may already have counted frozen rows of its
    // own, and one sweep reports one number.
    result.skipped_hold += frozen.length;
    return finish(result);
  } catch (err) {
    if (opts.log && outboxFailure !== null && err !== outboxFailure) {
      logFailure(
        opts.log,
        outboxFailure,
        { sweep: 'retention', pass: 'email_outbox' },
        'the outbox retention pass also failed; its error is being dropped for the archival pass’s',
      );
    }
    throw err;
  }
}

export function registerRetentionRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const requireAdmin = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal)) throw problems.forbidden('Retention settings are admin-only');
    return principal;
  };

  /**
   * One line in the audit spine per governance decision.
   *
   * Fire-after-success, like every other `recordAdminEvent` caller: the action
   * has already happened and the reviewer's record of it must not be the thing
   * that fails the request.
   *
   * `subjectLabel` carries the human name — the data type, the reason, the
   * company — because the spine is read as prose and a ULID is not one.
   */
  const audit = async (
    actorId: string,
    type: AdminEventType,
    subjectType: string,
    subjectId: string | null,
    subjectLabel: string | null,
    payload: Record<string, unknown> = {},
  ) => {
    await recordAdminEvent(deps.pool, {
      type,
      actor: { actorType: 'human', actorId },
      subjectType,
      subjectId,
      subjectLabel,
      payload,
    });
  };

  /**
   * The policies, each carrying what the sweep will actually do with it.
   *
   * The row alone cannot say. Four of the five data types were settable and
   * read by nothing, and the console rendered all five identically — three
   * numbers and a checkbox — so an operator setting an age on `document` saw
   * the same confirmation as one setting an age on `valuation` and got a
   * different outcome. `enforcement` is served with the row so the screen can
   * distinguish them; it is declared in domain/retention.ts and is a constant,
   * not a column, because it describes the code rather than the deployment.
   */
  app.get('/api/v1/admin/retention/policies', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    const policies = await listPolicies(deps.pool);
    return {
      policies: policies.map((p) => ({
        ...p,
        // A data type in the table but not in the enum is a row somebody
        // inserted by hand; it is reported as unenforced, which is true.
        enforcement: RETENTION_ENFORCEMENT[p.data_type as RetentionDataType] ?? {
          archives: false,
          purges: false,
          note: 'Not a data type this build knows about; nothing acts on it.',
        },
      })),
    };
  });

  app.put('/api/v1/admin/retention/policies/:dataType', { preHandler: app.authenticate }, async (req) => {
    const principal = requireAdmin(req);
    const { dataType } = req.params as { dataType: string };
    if (!(RETENTION_DATA_TYPES as readonly string[]).includes(dataType)) throw problems.notFound();
    const parsed = PolicyBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid policy', parsed.error);
    const policy = await upsertPolicy(deps.pool, {
      dataType,
      archiveAfterDays: parsed.data.archive_after_days,
      retentionDays: parsed.data.retention_days,
      enabled: parsed.data.enabled,
      updatedBy: principal.id,
    });
    await audit(principal.id, 'retention_policy_updated', 'retention_policy', null, dataType, {
      archive_after_days: parsed.data.archive_after_days,
      retention_days: parsed.data.retention_days,
      enabled: parsed.data.enabled,
    });
    return { policy };
  });

  app.get('/api/v1/admin/retention/holds', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(HOLD_PAGE_LIMIT).default(HOLD_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      throw invalidQuery(parsedQuery.error);
    }
    const { holds, truncated } = await listHolds(deps.pool, { limit: parsedQuery.data.limit });
    return { holds, truncated, page_limit: HOLD_PAGE_LIMIT };
  });

  app.post('/api/v1/admin/retention/holds', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireAdmin(req);
    const parsed = HoldBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid hold', parsed.error);
    if (parsed.data.scope !== 'global' && !parsed.data.reference_id) {
      throw problems.unprocessable('A valuation/user hold needs a reference_id');
    }
    if (parsed.data.scope !== 'global') {
      await assertHoldTarget(deps.pool, parsed.data.scope, parsed.data.reference_id!);
    }
    const hold = await placeHold(deps.pool, {
      scope: parsed.data.scope,
      referenceId: parsed.data.scope === 'global' ? null : (parsed.data.reference_id ?? null),
      reason: parsed.data.reason,
      placedBy: principal.id,
    });
    await audit(principal.id, 'legal_hold_placed', 'legal_hold', hold.id, parsed.data.reason, {
      scope: hold.scope,
      reference_id: hold.reference_id,
    });
    return reply.status(201).send({ hold });
  });

  app.post('/api/v1/admin/retention/holds/:id/release', { preHandler: app.authenticate }, async (req) => {
    const principal = requireAdmin(req);
    const { id } = req.params as { id: string };
    if (!(await releaseHold(deps.pool, id, principal.id))) throw problems.notFound();
    await audit(principal.id, 'legal_hold_released', 'legal_hold', id, null);
    return { released: true };
  });

  app.get('/api/v1/admin/retention/actions', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    return { actions: await listActions(deps.pool) };
  });

  /**
   * What is withdrawn right now, as opposed to what the sweep did.
   *
   * The restore control was only ever offered against an `archived` row in the
   * log above, and the log is a history: newest first, and capped. One Sunday
   * sweep archiving forty engagements pushes last week's withdrawal past the
   * end of it, and the only route back goes with it — invisibly, because a
   * truncated list is indistinguishable from a complete one. R90 made
   * retirement reversible and this is what makes the reversal findable.
   *
   * `q` matches the company name or an exact id. The name is the one an admin
   * has: a support request says "restore the Acme engagement", never a ULID.
   * `total` is the size of the match before the limit, so the page can say
   * "showing 50 of 214" instead of quietly showing 50.
   */
  const RetiredQuery = z.object({
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });

  app.get('/api/v1/admin/retention/valuations/retired', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    const parsed = RetiredQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw invalidQuery(parsed.error);
    const { rows, total } = await listRetiredValuations(deps.pool, parsed.data);
    return { valuations: rows, total, limit: parsed.data.limit ?? 50 };
  });

  /**
   * Withdraw an engagement from the product.
   *
   * THE GAP THIS CLOSES IS AN ODD ONE: the whole retirement guard family was
   * built for an action that did not exist. Four rounds of comments say
   * `archived_at` is stamped "by the retention sweep when a policy period runs
   * out, and by `retireValuations` when a firm withdraws a piece of work" —
   * and `retireValuations` had exactly one caller, the sample seeder. So the
   * 86 guarded writes, the partner API's three, the auditor portal's refusal to
   * re-share and the board flow's refusal to re-mint were all reachable only by
   * waiting out a retention policy. An admin who needed to withdraw a live
   * engagement today had no way to do it at all.
   *
   * IT RECORDS `archived`, not a new action name. That is the same thing the
   * sweep does to the same column, and keeping one name means the restore
   * control offers itself against a manual retirement without knowing there is
   * such a thing. `manual: true` in the detail is what separates them for
   * anyone reading the log, and `reason` is what the sweep can never supply.
   *
   * THE RENAME COMES WITH IT. `retireValuations` appends ` [retired]` so the
   * company name is free for a re-run, and this route shares that path rather
   * than forking it: the suffix reads as what the row is, `restoreValuations`
   * takes it off again, and a second retirement cannot double it. Named in the
   * response because an admin who did not expect the company name to change
   * should find out from the answer and not from a support ticket.
   */
  const RetireBody = z.object({ reason: z.string().trim().min(1).max(1000).optional() });

  app.post('/api/v1/admin/retention/valuations/:id/retire', { preHandler: app.authenticate }, async (req) => {
    const principal = requireAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const parsed = RetireBody.safeParse(req.body ?? {});
    if (!parsed.success) throw invalidBody('Invalid body', parsed.error);

    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    if (valuation.archived_at !== null) {
      throw problems.conflict('This engagement is already retired.');
    }

    const result = await retireValuations(deps.pool, [id]);
    // Empty means a concurrent retire won the UPDATE. The engagement is
    // withdrawn either way, which is what the caller asked for, so this
    // reports rather than raises — and does not log an archival it did not do.
    const retired = result.retired.includes(id);
    if (retired) {
      await recordActions(deps.pool, [
        {
          dataType: 'valuation',
          action: 'archived',
          referenceId: id,
          detail: { manual: true, retired_by: principal.id, reason: parsed.data.reason ?? null },
        },
      ]);
      // The audit first (round 273, methodology M11). The retirement has
      // already committed, and this event is the spine's record of *who* did
      // it — so it must not sit behind an announcement to somebody else. It
      // did: `firePartnerWebhooksForRetirement` awaited a `SELECT` here, and a
      // statement timeout on it answered the admin 500 for work that had
      // landed and skipped `valuation_retired` on the way out, leaving a
      // retirement on the retention log and off the admin trail. The door is
      // contained now; the order is what makes it not matter next time.
      await audit(principal.id, 'valuation_retired', 'valuation', id, valuation.company_name, {
        reason: parsed.data.reason ?? null,
      });
      // A partner integration otherwise finds out by a 409 on its next write,
      // or never. `valuation.retired` is the only terminal event on that API
      // and this is one of the two things that produces it.
      await firePartnerWebhooksForRetirement({ pool: deps.pool, log: app.log }, [id]);
    }
    return { retired, valuation: await findValuationById(deps.pool, id) };
  });

  /**
   * Put an archived valuation back in the product.
   *
   * THE GAP THIS CLOSES. `archived_at` is the platform's soft delete and
   * nothing ever cleared it. Two things set it — this sweep, and
   * `retireValuations` when a firm withdraws work — and R89 then made every
   * one of the 86 writes under a valuation id refuse a stamped row. That was
   * the right call and it turned a tidiness problem into a real one: an
   * engagement archived by a mistyped id, or by a policy an admin set to 90
   * days meaning 900, was permanently frozen with no way back through the
   * product. Users have `restoreUser`; partners have their own unarchive; the
   * aggregate holding a client's actual work had neither.
   *
   * WHY IT LIVES ON THE RETENTION SURFACE. This is where valuations get
   * archived in-product and where the action log that records it is read, so
   * the undo belongs next to the log entry it undoes rather than on the
   * engagement page — which is also the honest place for it, because it is an
   * admin action and not something the firm doing the work can do to itself.
   *
   * WHY IT CAN REFUSE. A restore whose only effect is to be undone by tonight's
   * sweep is worse than no restore: the admin sees a 200, the engagement comes
   * back, and it is gone again by morning with nothing to say why. So the same
   * two questions the sweep asks are asked here first — is it past the policy's
   * cutoff, and is a legal hold freezing it — and if the sweep would take it
   * straight back, this refuses and names the two things that would actually
   * hold it: widen the policy, or place a hold. `acknowledge_rearchival` is
   * there because "restore it anyway, I know" is a legitimate thing to want —
   * exporting a file before it goes again — and choosing that for the operator
   * is not this route's job. What is its job is that they cannot choose it by
   * accident.
   */
  const RestoreBody = z.object({ acknowledge_rearchival: z.boolean().optional() });

  app.post(
    '/api/v1/admin/retention/valuations/:id/restore',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requireAdmin(req);
      const { id } = req.params as { id: string };
      if (!isUlid(id)) throw problems.notFound();
      const parsed = RestoreBody.safeParse(req.body ?? {});
      if (!parsed.success) throw invalidBody('Invalid body', parsed.error);

      const valuation = await findValuationById(deps.pool, id);
      if (!valuation) throw problems.notFound();
      // Deliberately not a 404: the caller is looking at a real engagement and
      // the reason there is nothing to do is its state. Same reasoning as
      // `refuseIfRetired`, pointed the other way.
      if (valuation.archived_at === null) {
        throw problems.conflict('This engagement is not archived — there is nothing to restore.');
      }

      if (parsed.data.acknowledge_rearchival !== true) {
        const policy = (await listPolicies(deps.pool)).find((p) => p.data_type === 'valuation');
        const due = policy ? isDueForArchival(policy, valuation.created_at, new Date()) : false;
        // The hold check is second because it is the one that costs a query,
        // and it only matters when the policy would otherwise take the row.
        if (due && !(await isValuationFrozen(deps.pool, { valuationId: id, userId: valuation.user_id }))) {
          throw problems.conflict(
            `The retention policy archives valuations after ${policy!.archive_after_days} days and this ` +
              'one is older than that, so the next sweep would archive it again. Widen the policy or ' +
              'place a legal hold on it first, or resend with acknowledge_rearchival to restore it ' +
              'anyway.',
          );
        }
      }

      const result = await restoreValuations(deps.pool, [id]);
      // `restored` empty means a concurrent restore won the UPDATE. Nothing was
      // wrong with the request and the engagement is live, which is what the
      // caller wanted — so this reports the outcome rather than raising.
      const restored = result.restored.includes(id);
      if (restored) {
        // The second write the restore makes, and the one nobody asked for:
        // `restoreValuations` moves `engagements.stage_entered_at` forward by
        // the length of the withdrawal, because the SLA clock ran through it
        // and the engagement would otherwise come back instantly red. That is
        // the column the board colours by and the overdue sweep picks its
        // recipients from, and the stage trail beside it deliberately keeps
        // the original `entered_at` — so without this the two disagree and
        // the retention log says only "restored". Named on both ledgers and
        // in the answer, so nobody has to already know the repair exists.
        const slaCredited = result.slaCredited.map((c) => ({
          valuation_id: c.valuationId,
          stage: c.stage,
          credited_seconds: c.creditedSeconds,
        }));
        await recordActions(deps.pool, [
          {
            dataType: 'valuation',
            action: 'restored',
            referenceId: id,
            detail: {
              restored_by: principal.id,
              archived_at: valuation.archived_at.toISOString(),
              acknowledged_rearchival: parsed.data.acknowledge_rearchival === true,
              sla_credited: slaCredited,
            },
          },
        ]);
        await audit(principal.id, 'valuation_restored', 'valuation', id, valuation.company_name, {
          archived_at: valuation.archived_at.toISOString(),
          acknowledged_rearchival: parsed.data.acknowledge_rearchival === true,
          sla_credited: slaCredited,
        });
        return {
          restored,
          sla_credited: slaCredited,
          valuation: await findValuationById(deps.pool, id),
        };
      }
      return { restored, sla_credited: [], valuation: await findValuationById(deps.pool, id) };
    },
  );

  // Manual sweep trigger (admins), in addition to the scheduled run.
  app.post('/api/v1/admin/retention/run', { preHandler: app.authenticate }, async (req) => {
    requireAdmin(req);
    return { result: await runRetentionSweep(deps.pool, { log: app.log }) };
  });
}
