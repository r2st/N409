import { z } from 'zod';

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

/**
 * The roles one request body may name.
 *
 * `z.array(z.enum(ROLE_KEYS))` bounds each *element* and not the array, so the
 * three admin-user schemas that spelled it that way were capped only by
 * Fastify's 1 MB body — about 60,000 repetitions of `"admin"`, all of which
 * reached `assignRoles` as a single `text[]` parameter for a table with as many
 * rows as there are keys above. There are only so many distinct roles, so a
 * longer list is naming one of them twice.
 */
export const RoleSet = z.array(z.enum(ROLE_KEYS)).max(ROLE_KEYS.length);

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

/**
 * Who hears about money going wrong — a refund, a chargeback, a bounced debit,
 * a failed renewal. Deliberately the smallest set that can actually act on one:
 * a chargeback has a Stripe response deadline and a failed renewal needs
 * somebody to call the client, and neither is a reviewer's job. Sent to the
 * whole ops group instead, these would be ignorable within a week.
 */
export const BILLING_ALERT_ROLES: readonly RoleKey[] = ['admin', 'god', 'supervisor'];

/**
 * Who hears that a background queue has stopped or is failing.
 *
 * The same three as billing, and for the same reason: a stalled outbox needs
 * somebody who can restart a service or open a provider ticket, and a reviewer
 * cannot do either. `data` and `data_supervisor` are the near miss — they read
 * the job monitor daily — but the alert is about infrastructure, not about the
 * work in the queue, and widening it is how the notification list becomes noise.
 */
export const JOB_ALERT_ROLES: readonly RoleKey[] = ['admin', 'god', 'supervisor'];

/**
 * Who hears that an outside auditor has put something on the record.
 *
 * The engagement's assigned reviewer is notified regardless — it is their file
 * — and this is the set that covers the case the reviewer cannot: an
 * engagement nobody is assigned to, or one whose reviewer has moved on. An
 * auditor note is the one inbound message on this platform with a deadline
 * attached to somebody else's audit, so it must not be able to land in a thread
 * nobody is watching.
 *
 * `main_reviewer` over the whole reviewer group for the reason the two sets
 * above give: a note every reviewer gets is a note none of them owns.
 */
export const AUDITOR_NOTE_ROLES: readonly RoleKey[] = ['admin', 'god', 'supervisor', 'main_reviewer'];
