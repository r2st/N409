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
export function isFrozen(
  holds: LegalHold[],
  target: { valuationId: string; userId: string },
): boolean {
  return holds.some((h) => {
    if (!h.active) return false;
    if (h.scope === 'global') return true;
    if (h.scope === 'valuation') return h.reference_id === target.valuationId;
    if (h.scope === 'user') return h.reference_id === target.userId;
    return false;
  });
}
