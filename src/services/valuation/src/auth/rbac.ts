import { CLIENT_ROLES, OPS_ROLES, PARTNER_ROLES, USER_ADMIN_ROLES, type RoleKey } from '../domain/roles.js';

/**
 * RBAC policy layer with partner scoping (issue #3, system-design §7).
 * Pure functions — no I/O — so policies are unit-testable and reusable
 * across services.
 */
export interface Principal {
  id: string;
  roles: RoleKey[];
  partnerId: string | null;
}

export type ValuationScope =
  | { kind: 'all' }
  | { kind: 'partner'; partnerId: string }
  | { kind: 'own'; userId: string }
  | { kind: 'none' };

/** What slice of the valuation table can this principal see? */
export function valuationScope(p: Principal): ValuationScope {
  if (p.roles.length === 0 || p.roles.includes('ignored')) return { kind: 'none' };
  if (p.roles.some((r) => OPS_ROLES.has(r))) return { kind: 'all' };
  if (p.roles.some((r) => PARTNER_ROLES.has(r))) {
    return p.partnerId ? { kind: 'partner', partnerId: p.partnerId } : { kind: 'none' };
  }
  if (p.roles.some((r) => CLIENT_ROLES.has(r))) return { kind: 'own', userId: p.id };
  return { kind: 'none' };
}

export interface ValuationRef {
  userId: string;
  partnerId: string | null;
}

/** Can the principal read this specific valuation (incl. its events)? */
export function canReadValuation(p: Principal, v: ValuationRef): boolean {
  const scope = valuationScope(p);
  switch (scope.kind) {
    case 'all':
      return true;
    case 'partner':
      return v.partnerId === scope.partnerId;
    case 'own':
      return v.userId === scope.userId;
    case 'none':
      return false;
  }
}

export function canCreateValuation(p: Principal): boolean {
  return valuationScope(p).kind !== 'none';
}

/** Fields ops can PATCH vs. what a client-owner can PATCH on their own valuation. */
export const OPS_PATCH_FIELDS: ReadonlySet<string> = new Set([
  'company_name',
  'service_name',
  'state', // guarded transitions arrive in M1 (#5); M0 records the change as an event
  'waiting_on_client',
  'assigned_reviewer_id',
  'due_date',
  'delivery_days',
  'paid_status',
  'currency',
  'service_countries',
  'qsbs_attestation',
]);

export const OWNER_PATCH_FIELDS: ReadonlySet<string> = new Set([
  'company_name',
  'service_name',
  'qsbs_attestation',
]);

export function patchableFields(p: Principal, v: ValuationRef): ReadonlySet<string> {
  if (p.roles.some((r) => OPS_ROLES.has(r))) return OPS_PATCH_FIELDS;
  if (canReadValuation(p, v) && v.userId === p.id) return OWNER_PATCH_FIELDS;
  return new Set();
}

export function isOps(p: Principal): boolean {
  return p.roles.some((r) => OPS_ROLES.has(r));
}

export function canManageUsers(p: Principal): boolean {
  return p.roles.some((r) => USER_ADMIN_ROLES.has(r));
}
