/**
 * Data retention + legal hold policy logic (feature 10). Pure helpers so the
 * archival decisions are unit-testable independent of the DB and the scheduler.
 */

export const RETENTION_DATA_TYPES = [
  'valuation',
  'document',
  'calculation',
  'email_outbox',
  'audit_event',
] as const;

export type RetentionDataType = (typeof RETENTION_DATA_TYPES)[number];

/**
 * Every action name the decision log accepts, matching the CHECK on
 * `retention_actions.action` (migrations 0083, 0165, 0174).
 *
 * `purge_eligible` is declared and never written, which is deliberate and is
 * the distinction the pair carries: it means "aged past its policy, and a
 * person decides", where `purged` means "gone".
 */
export const RETENTION_ACTION_NAMES = [
  'archived',
  'skipped_hold',
  'purge_eligible',
  'restored',
  'purged',
] as const;

export type RetentionActionName = (typeof RETENTION_ACTION_NAMES)[number];

/**
 * What the sweep actually does with each data type — and, where it does
 * nothing, that this is a decision rather than an omission.
 *
 * The five types above have been settable from the admin console since feature
 * 10 shipped: three numbers and a checkbox each, saved to `retention_policies`,
 * with an action log beneath them. `runRetentionSweep` implemented exactly one
 * of them. `document`, `calculation`, `email_outbox` and `audit_event` were
 * accepted by the PUT, stored, listed back, and read by nothing — an operator
 * could set "retain email_outbox for 730 days", tick enabled, watch it save,
 * and the mail would sit there for as long as the table existed.
 *
 * That is the worst shape a compliance control can have. An unimplemented
 * feature is visibly missing; a control that saves and does nothing is
 * indistinguishable from one that works, and the thing it is supposed to
 * govern here is storage limitation over a table of recipients' addresses and
 * message bodies. `domain/housekeeping.ts` had already written the claim down
 * as fact — "audit events, activity, notifications and the email outbox all
 * age out through the retention policy engine" — which was the reading anyone
 * would take from the schema, and none of it was true.
 *
 * So enforcement is declared here, per type, next to the list that produces
 * the console's rows; `retentionEnforcement.test.ts` holds this table against
 * what the sweep implements in both directions, and the policies endpoint
 * serves it so the console can say which control is live and which is a
 * setting nothing reads.
 */
export interface RetentionEnforcement {
  /** Sets `archived_at`, hiding the record without destroying it. */
  archives: boolean;
  /** Deletes rows once `retention_days` has elapsed. */
  purges: boolean;
  /** What an operator is agreeing to, or why the setting is inert. */
  note: string;
}

export const RETENTION_ENFORCEMENT: Record<RetentionDataType, RetentionEnforcement> = {
  valuation: {
    archives: true,
    purges: false,
    note:
      'Archives engagements past `archive_after_days` by stamping `archived_at`, skipping any under ' +
      'a legal hold. Nothing deletes them: `retention_days` is recorded for the policy it states and ' +
      'is not acted on, because an engagement is the working paper behind a filed valuation and its ' +
      'destruction is a decision a person makes one at a time. Retirement is reversible from the ' +
      'retention screen.',
  },
  document: {
    archives: false,
    purges: false,
    note:
      'Not enforced. A document is a row plus a blob on disk plus a place in the evidence trail of a ' +
      'valuation that cites it, and ageing the row out on a clock would leave a report referring to a ' +
      'file nobody can produce. Uploads go when their engagement is purged, which is the only order ' +
      'that keeps the citation honest.',
  },
  calculation: {
    archives: false,
    purges: false,
    note:
      'Not enforced. A calculation is the arithmetic a concluded fair market value came from; deleting ' +
      'it leaves a published per-share figure with nothing behind it. It is kept for as long as the ' +
      'engagement is, and goes with it.',
  },
  email_outbox: {
    archives: false,
    purges: true,
    note:
      'Deletes sent, skipped and exhausted messages older than `retention_days`, unless a legal hold ' +
      'covers the recipient, the engagement, or everything. This is the one store here that is purely ' +
      'a record of correspondence — an address, a subject and a body, and for the transactional ' +
      'templates a link that was a credential when it was written — so keeping it forever is the ' +
      'exposure rather than the safeguard. `archive_after_days` is inert for this type: an outbox row ' +
      'has no archived state to move to.',
  },
  audit_event: {
    archives: false,
    purges: false,
    note:
      'Not enforced, and seeded with no ages for the same reason. The audit trail is what answers "who ' +
      'did this" about every other retention decision on this screen, including the ones that delete ' +
      'things; a policy that could age it out would be the one setting able to erase the evidence that ' +
      'it ran.',
  },
};

export interface RetentionPolicy {
  data_type: string;
  archive_after_days: number | null;
  retention_days: number | null;
  enabled: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days between two instants (created → now), floored. */
export function ageInDays(createdAt: Date, now: Date): number {
  return Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS);
}

/** True when an enabled policy says a record of this age should be archived. */
export function isDueForArchival(policy: RetentionPolicy, createdAt: Date, now: Date): boolean {
  if (!policy.enabled || policy.archive_after_days === null) return false;
  return ageInDays(createdAt, now) >= policy.archive_after_days;
}

/** True when a record is old enough to be eligible for purge (informational). */
export function isPurgeEligible(policy: RetentionPolicy, createdAt: Date, now: Date): boolean {
  if (!policy.enabled || policy.retention_days === null) return false;
  return ageInDays(createdAt, now) >= policy.retention_days;
}

export interface LegalHold {
  scope: 'global' | 'valuation' | 'user';
  reference_id: string | null;
  active: boolean;
}

/**
 * Whether a valuation (owned by userId) is frozen by any active hold — a global
 * hold, a hold on the valuation, or a hold on its owner.
 */
export function isFrozen(holds: LegalHold[], target: { valuationId: string; userId: string }): boolean {
  return holds.some((h) => {
    if (!h.active) return false;
    if (h.scope === 'global') return true;
    if (h.scope === 'valuation') return h.reference_id === target.valuationId;
    if (h.scope === 'user') return h.reference_id === target.userId;
    return false;
  });
}
