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

/**
 * Admin / normal-user view toggle (admin-role-management feature B). Purely a
 * client-side preview — the API always enforces the admin's real roles.
 */
export type ViewMode = 'admin' | 'normal';

/**
 * The role set an admin should be *rendered* as having in the current view
 * mode. In 'normal' view we strip every ops/admin/partner role and keep only
 * client-level ones, so the UI shows exactly what a client would see. A user
 * with no client role falls back to `valuation_user`.
 */
export function effectiveRoles(user: Pick<User, 'roles'>, viewMode: ViewMode): string[] {
  if (viewMode !== 'normal') return user.roles;
  const clientRoles = user.roles.filter((r) => CLIENT_ROLES.has(r));
  return clientRoles.length > 0 ? clientRoles : ['valuation_user'];
}

/**
 * A shallow copy of the user with roles filtered to the effective view mode.
 * Feed this to the RBAC predicates for UI gating; keep the *real* user for the
 * toggle itself and for anything that hits the API.
 */
export function effectiveUser<T extends { roles: string[] }>(user: T | null, viewMode: ViewMode): T | null {
  if (!user || viewMode !== 'normal') return user;
  return { ...user, roles: effectiveRoles(user, viewMode) };
}

export function isOps(user: Pick<User, 'roles'> | null): boolean {
  return Boolean(user?.roles.some((r) => OPS_ROLES.has(r)));
}

/**
 * Does this account sign in with a password?
 *
 * The question behind every "confirm your current password" box on the
 * settings page, and it was asked as `sso_provider !== 'google'` at five call
 * sites. That is right for the two account kinds the product started with and
 * wrong for the third: a SAML- or SCIM-provisioned user has no password digest
 * *and* no `sso_provider` (migration 0082), so every one of those reads treated
 * them as a password account and put a box on screen they could never fill —
 * the server skips its own check for them, but `useFormValidation` refused to
 * submit the form.
 *
 * The server states it now (`has_password` on the `/me` payload). The
 * `sso_provider` fallback is only for a payload minted before it did.
 */
export function hasPassword(user: Pick<User, 'has_password' | 'sso_provider'> | null): boolean {
  return user?.has_password ?? user?.sso_provider !== 'google';
}

export function isPartner(user: Pick<User, 'roles'> | null): boolean {
  return !isOps(user) && Boolean(user?.roles.some((r) => PARTNER_ROLES.has(r)));
}

export function canManageUsers(user: Pick<User, 'roles'> | null): boolean {
  return Boolean(user?.roles.some((r) => USER_ADMIN_ROLES.has(r)));
}

/**
 * Who sees the firm console. Everyone inside a firm — `partner` and `member`
 * alike, since it only shows their own firm's book, which they can already
 * list — plus ops, who open a named firm's console from the partner console.
 */
export function canUseFirmConsole(user: Pick<User, 'roles'> | null): boolean {
  return isPartner(user) || isOps(user);
}

/**
 * Who may white-label their firm (mirrors canManageBranding in auth/rbac.ts):
 * a firm's own `partner` administrator, or platform admins for any firm.
 * `member` is the ordinary seat inside a firm and is deliberately excluded.
 */
export function isFirmAdmin(user: Pick<User, 'roles'> | null): boolean {
  return Boolean(user?.roles.includes('partner')) || canManageUsers(user);
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
