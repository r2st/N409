/**
 * Role model (issue #3). Role keys mirror the observed production set
 * (database-design.md §6). The policy layer groups them into scopes:
 *  - ops roles      → see/manage all valuations
 *  - partner roles  → scoped to their partner_id
 *  - client roles   → scoped to valuations they own
 *  - 'ignored'      → no access
 */
export const ROLE_KEYS = [
  'valuation_user',
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
  'partner',
  'member',
  'investor',
  'auto',
  'spa',
  'ignored',
  'auditor',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

export const OPS_ROLES: ReadonlySet<RoleKey> = new Set([
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

export const PARTNER_ROLES: ReadonlySet<RoleKey> = new Set(['partner', 'member']);

export const CLIENT_ROLES: ReadonlySet<RoleKey> = new Set(['valuation_user', 'investor']);

/** Roles allowed to administer users/roles/partners. */
export const USER_ADMIN_ROLES: ReadonlySet<RoleKey> = new Set(['admin', 'god', 'supervisor']);
