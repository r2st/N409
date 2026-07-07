import type { User } from './types';

/**
 * Client-side mirror of the valuation service's RBAC groupings
 * (src/services/valuation/src/domain/roles.ts). Purely cosmetic — the API
 * enforces the real policy; the UI just hides what a role can't use.
 */
export const OPS_ROLES = new Set([
  'admin',
  'god',
  'supervisor',
  'support',
  'support_supervisor',
  'reviewer',
  'main_reviewer',
  'contributing_reviewer',
  'data',
  'data_supervisor',
  'auto',
  'spa',
]);

export const PARTNER_ROLES = new Set(['partner', 'member']);
export const CLIENT_ROLES = new Set(['valuation_user', 'investor']);
export const USER_ADMIN_ROLES = new Set(['admin', 'god', 'supervisor']);

export function isOps(user: Pick<User, 'roles'> | null): boolean {
  return Boolean(user?.roles.some((r) => OPS_ROLES.has(r)));
}

export function isPartner(user: Pick<User, 'roles'> | null): boolean {
  return !isOps(user) && Boolean(user?.roles.some((r) => PARTNER_ROLES.has(r)));
}

export function canManageUsers(user: Pick<User, 'roles'> | null): boolean {
  return Boolean(user?.roles.some((r) => USER_ADMIN_ROLES.has(r)));
}

/** Which valuation fields this user may PATCH (mirrors auth/rbac.ts). */
export function editableFields(user: User | null, valuation: { user_id: string }): Set<string> {
  if (isOps(user)) {
    return new Set([
      'company_name',
      'service_name',
      'state',
      'waiting_on_client',
      'assigned_reviewer_id',
      'due_date',
      'delivery_days',
      'paid_status',
      'currency',
      'service_countries',
      'qsbs_attestation',
    ]);
  }
  if (user && valuation.user_id === user.id) {
    return new Set(['company_name', 'service_name', 'qsbs_attestation']);
  }
  return new Set();
}

/** Human description of what slice of data the user sees. */
export function scopeLabel(user: User | null): string {
  if (isOps(user)) return 'All valuations (operations)';
  if (isPartner(user)) return 'Your partner portfolio';
  return 'Your valuations';
}
