import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AdminEventType } from '../domain/auditTrail.js';
import { httpsUrl } from '../domain/externalUrl.js';
import { isUlid, problems } from '@n409/shared';
import { canManageUsers, isOps } from '../auth/rbac.js';
import { PARTNER_ROLES, ROLE_KEYS, RoleSet, USER_ADMIN_ROLES, type RoleKey } from '../domain/roles.js';
import { CAPABILITIES, ROLE_DEFS, capabilitiesFor } from '../domain/permissions.js';
import { normalizeSubdomain } from '../domain/partnerSubdomain.js';
import { NullablePhone } from '../domain/phone.js';
import { listValuations } from '../repos/valuations.js';
import { VALUATION_STATES } from '../domain/valuation.js';
import { toCsv } from '../domain/csv.js';
import { MAX_EXPORT_ROWS, sendExport, truncationOf } from './exports.js';
import { hashPassword } from '../auth/password.js';
import { PASSWORD_MIN_LENGTH, passwordPolicyError } from '../domain/passwordPolicy.js';
import type { SystemSettingsStore } from '../repos/systemSettings.js';
import { bumpSessionEpoch, createUser, findUserByEmail, findUserById } from '../repos/users.js';
import { createPasswordResetToken } from '../repos/passwordResets.js';
import {
  adminPatchUser,
  createPartner,
  findPartnerBrandingByKey,
  findPartnerById,
  getPartnerDetail,
  listPartners,
  listUserOptions,
  listUsers,
  PICKER_LIMIT,
  restoreUser,
  softDeleteUser,
  updatePartner,
  type AdminUserRow,
} from '../repos/adminUsers.js';
import {
  createInvitation,
  hasPendingInvitation,
  InvitationPendingError,
  listInvitations,
  refreshInvitation,
  revokeInvitation,
  type InvitationListRow,
  type InvitationRow,
} from '../repos/invitations.js';
import {
  invitationEmail,
  passwordResetEmail,
  PARTNER_EMAIL_TEMPLATE_KEYS,
} from '../domain/emailWorkflows.js';
import { sendTransactionalEmail } from '../email/transactional.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { buildPersonalDataExport } from '../repos/dataExport.js';
import type { EmailTransport } from '../hooks/stateChange.js';
import { requirePrincipal } from '../plugins/auth.js';
import { EmailAddress } from '../domain/email.js';
import { pageParam } from '../domain/pagination.js';
import { flagParam } from '../domain/queryFlag.js';
import { isUniqueViolation } from '../db/pgError.js';

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  role: z.enum(ROLE_KEYS).optional(),
  partner_id: z.string().optional(),
  include_deleted: flagParam(false),
  page: pageParam(),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

const CreateBody = z.object({
  email: EmailAddress,
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`),
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  partner_id: z.string().nullable().optional(),
  verified: z.boolean().optional(),
  roles: RoleSet.min(1),
});

const PatchBody = z
  .object({
    email: EmailAddress,
    first_name: z.string().max(100).nullable(),
    last_name: z.string().max(100).nullable(),
    phone: NullablePhone,
    job_title: z.string().max(150).nullable(),
    company_name: z.string().max(200).nullable(),
    verified: z.boolean(),
    partner_id: z.string().nullable(),
    roles: RoleSet,
  })
  .partial()
  .strict();

function toAdminUser(u: AdminUserRow) {
  return {
    id: u.id,
    email: u.email,
    first_name: u.first_name,
    last_name: u.last_name,
    phone: u.phone,
    job_title: u.job_title,
    company_name: u.company_name,
    verified: u.verified,
    sso_provider: u.sso_provider,
    partner_id: u.partner_id,
    partner_name: u.partner_name ?? null,
    roles: u.roles,
    created_at: u.created_at,
    deleted_at: u.deleted_at,
  };
}

const InviteBody = z.object({
  email: EmailAddress,
  roles: RoleSet.min(1),
  partner_id: z.string().nullable().optional(),
});

function toInvitation(i: InvitationRow | InvitationListRow) {
  const listRow = i as InvitationListRow;
  return {
    id: i.id,
    email: i.email,
    roles: i.roles,
    partner_id: i.partner_id,
    partner_name: listRow.partner_name ?? null,
    invited_by_email: listRow.invited_by_email ?? null,
    expires_at: i.expires_at,
    accepted_at: i.accepted_at,
    revoked_at: i.revoked_at,
    created_at: i.created_at,
  };
}

/** M3 feature 13 — user/role admin console (+ feature 16: users CSV export). */
export function registerAdminUserRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    transport?: EmailTransport;
    publicBaseUrl?: string;
    settings?: SystemSettingsStore;
  },
): void {
  const baseUrl = (deps.publicBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
  const requireUserAdmin = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal)) throw problems.forbidden();
    return principal;
  };

  /**
   * P1 #7 — partner/member roles are meaningless without an organisation
   * (the user would be scoped to nothing), so reject that combination.
   */
  const assertPartnerScopeConsistent = (roles: readonly string[], partnerId: string | null) => {
    if (!partnerId && roles.some((r) => PARTNER_ROLES.has(r as RoleKey))) {
      throw problems.unprocessable('Partner and member roles require a partner organisation', {
        errors: [{ path: ['partner_id'] }],
      });
    }
  };

  /** New partner assignments must reference a live (non-archived) partner. */
  const assertAssignablePartner = async (partnerId: string) => {
    const partner = isUlid(partnerId) ? await findPartnerById(deps.pool, partnerId) : null;
    if (!partner) throw problems.unprocessable('Unknown partner', { errors: [{ path: ['partner_id'] }] });
    if (partner.archived_at)
      throw problems.unprocessable('This partner is archived', { errors: [{ path: ['partner_id'] }] });
  };

  // P2 #12 — every admin console mutation lands in the audit log with the
  // acting admin as the human actor.
  const audit = async (
    actorId: string,
    type: AdminEventType,
    subjectType: 'user' | 'invitation' | 'partner',
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

  const sendInviteEmail = async (
    req: FastifyRequest,
    invitation: InvitationRow,
    secret: string,
    invitedByEmail: string,
  ) => {
    // Fragment, not query string — the token never reaches server logs.
    const link = `${baseUrl}/accept-invite#token=${secret}`;
    const template = invitationEmail(link, invitedByEmail);
    await sendTransactionalEmail(
      { pool: deps.pool, transport: deps.transport, log: req.log },
      { toEmail: invitation.email, ...template, vars: { link, invited_by: invitedByEmail } },
    );
  };

  // ── Invitations (feature #9 — admin side) ──────────────────────────────────

  app.post('/api/v1/users/invite', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireUserAdmin(req);
    const parsed = InviteBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid invitation', { errors: parsed.error.issues });
    const { email, roles, partner_id } = parsed.data;
    assertPartnerScopeConsistent(roles, partner_id ?? null);
    if (partner_id) await assertAssignablePartner(partner_id);

    const existing = await findUserByEmail(deps.pool, email);
    if (existing && !existing.deleted_at)
      throw problems.conflict('An account with this email already exists');
    if (await hasPendingInvitation(deps.pool, email))
      throw problems.conflict('An invitation for this email is already pending');

    const inviter = await findUserById(deps.pool, principal.id);
    // The check above is a reading, not a reservation: the partial unique index
    // is what actually holds the address, and two admins inviting it at once
    // both pass the check before either inserts. Catching the loser's collision
    // here is what makes that a 409 with the same words as the guard rather
    // than a 500 — see `createInvitation`.
    const { invitation, secret } = await createInvitation(deps.pool, {
      email,
      roles,
      partnerId: partner_id ?? null,
      invitedBy: principal.id,
    }).catch((err: unknown) => {
      if (err instanceof InvitationPendingError)
        throw problems.conflict('An invitation for this email is already pending');
      throw err;
    });
    await sendInviteEmail(req, invitation, secret, inviter?.email ?? 'An administrator');
    await audit(principal.id, 'user_invited', 'invitation', invitation.id, email, { roles });
    return reply.status(201).send({ invitation: toInvitation(invitation) });
  });

  app.get('/api/v1/users/invitations', { preHandler: app.authenticate }, async (req) => {
    requireUserAdmin(req);
    const { invitations, truncated } = await listInvitations(deps.pool);
    return { invitations: invitations.map(toInvitation), truncated };
  });

  app.post('/api/v1/users/invitations/:id/resend', { preHandler: app.authenticate }, async (req) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();

    const refreshed = await refreshInvitation(deps.pool, id);
    if (!refreshed) throw problems.conflict('This invitation was already accepted or revoked');
    const inviter = await findUserById(deps.pool, principal.id);
    await sendInviteEmail(req, refreshed.invitation, refreshed.secret, inviter?.email ?? 'An administrator');
    await audit(principal.id, 'invitation_resent', 'invitation', id, refreshed.invitation.email);
    return { invitation: toInvitation(refreshed.invitation) };
  });

  app.delete('/api/v1/users/invitations/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const revoked = await revokeInvitation(deps.pool, id);
    if (!revoked) throw problems.notFound('No pending invitation to revoke');
    await audit(principal.id, 'invitation_revoked', 'invitation', id, null);
    return reply.status(204).send();
  });

  app.get('/api/v1/users', { preHandler: app.authenticate }, async (req) => {
    requireUserAdmin(req);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const { page, per_page, q, role, partner_id, include_deleted } = parsed.data;

    const { items, total } = await listUsers(deps.pool, {
      q,
      role,
      partnerId: partner_id,
      includeDeleted: include_deleted,
      page,
      perPage: per_page,
    });
    return { users: items.map(toAdminUser), page, per_page, total };
  });

  app.get('/api/v1/users/export', { preHandler: app.authenticate }, async (req, reply) => {
    requireUserAdmin(req);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const { q, role, partner_id, include_deleted } = parsed.data;

    /*
     * One row more than we will emit, so the file can say whether it is the
     * whole answer — the same device, and the same cap, as the valuations
     * export.
     *
     * This capped at ten thousand accounts and reported nothing. A user
     * directory export is a reconciliation artifact — somebody hands it to an
     * auditor as "everyone with access" — and the rows past the cap are exactly
     * the ones nobody thinks to look for, because a CSV that stops has no way
     * of looking like it stopped. `listUsers` hands back a `total` this route
     * was already discarding, but the count is a second statement over the same
     * WHERE and can disagree with the page under concurrent writes; the extra
     * row cannot.
     */
    const { items: fetched } = await listUsers(deps.pool, {
      q,
      role,
      partnerId: partner_id,
      includeDeleted: include_deleted,
      page: 1,
      perPage: MAX_EXPORT_ROWS + 1,
    });
    const { rows: items, truncated } = truncationOf(fetched);
    // `as const` so the names are checked against the row type rather than
    // widened to `string[]` — see the note on `toCsv`.
    const columns = [
      'id',
      'email',
      'first_name',
      'last_name',
      'phone',
      'job_title',
      'company_name',
      'verified',
      'roles',
      'partner_name',
      'sso_provider',
      'created_at',
      'deleted_at',
    ] as const;
    const csv = toCsv(columns, items);
    return sendExport(reply, truncated)
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="users.csv"')
      .send(csv);
  });

  /**
   * Picker options (reviewer/partner-user dropdowns). Ops-wide, not just user
   * admins — reviewers need the reviewer filter on the valuations list.
   */
  app.get('/api/v1/users/options', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden();
    const parsed = z
      .object({
        group: z.enum(['ops', 'partner']).default('ops'),
        q: z.string().trim().min(1).max(200).optional(),
        limit: z.coerce.number().int().min(1).max(PICKER_LIMIT).default(PICKER_LIMIT),
      })
      .safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query');
    return listUserOptions(deps.pool, parsed.data.group, {
      q: parsed.data.q,
      limit: parsed.data.limit,
    });
  });

  app.post('/api/v1/users', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireUserAdmin(req);
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid user', { errors: parsed.error.issues });
    const body = parsed.data;
    assertPartnerScopeConsistent(body.roles, body.partner_id ?? null);
    if (body.partner_id) await assertAssignablePartner(body.partner_id);

    /*
     * The same policy every other password entry point applies.
     *
     * This one applied neither half of it. The schema's `min(10)` is the
     * *floor*, not the effective minimum — `password_min_length` is a system
     * setting an administrator may raise, and the integration test asserting it
     * "tightens the floor for every password entry point" drove two of the five
     * — so a deployment configured to 16 went on accepting ten-character
     * passwords through the admin console, which is the one entry point whose
     * accounts tend to be the privileged ones. The complexity rule was missing
     * outright: `1234567890` was refused at registration, at reset, at invite
     * acceptance and at change-password, and created here.
     */
    const min = (await deps.settings?.get('password_min_length')) ?? PASSWORD_MIN_LENGTH;
    const weak = passwordPolicyError(body.password, min);
    if (weak) throw problems.unprocessable(weak, { errors: [{ path: ['password'] }] });

    if (await findUserByEmail(deps.pool, body.email))
      throw problems.conflict('An account with this email already exists');

    const user = await createUser(deps.pool, {
      email: body.email,
      passwordDigest: await hashPassword(body.password),
      firstName: body.first_name,
      lastName: body.last_name,
      partnerId: body.partner_id ?? null,
      verified: body.verified ?? true,
      roles: body.roles,
    });
    await audit(principal.id, 'user_created', 'user', user.id, user.email, { roles: body.roles });
    return reply.status(201).send({ user: { ...user, password_digest: undefined } });
  });

  /**
   * The same export as `GET /api/v1/me/data-export`, for one other person.
   *
   * Subject-access requests do not all arrive from inside the product. They
   * come by email, from ex-employees whose account is closed, and from people
   * who never had a login at all but appear in the platform because a firm
   * created an engagement for them — none of whom can serve themselves. Without
   * this the answer was assembled by hand at a psql prompt against a one-month
   * statutory deadline.
   *
   * Audited, unlike the self-serve half. One person reading another's personal
   * data is the event a compliance review asks about, and "an administrator
   * exported this account" is exactly the line it wants to find. It is
   * deliberately recorded before the export is built, so an export that then
   * fails still leaves the attempt on the record.
   *
   * A closed account is exportable. Its `deleted_at` is a soft delete, the data
   * is all still held, and someone asking what is held about them after closing
   * their account is the person with the most reason to ask.
   */
  app.get('/api/v1/users/:id/data-export', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const subject = await findUserById(deps.pool, id);
    if (!subject) throw problems.notFound();

    await audit(principal.id, 'user_data_exported', 'user', subject.id, subject.email, {
      subject_access_request: true,
    });

    const bundle = await buildPersonalDataExport(deps.pool, subject.id);
    const stamp = bundle.generated_at.slice(0, 10);
    return reply
      .type('application/json')
      .header('content-disposition', `attachment; filename="n409-data-export-${subject.id}-${stamp}.json"`)
      .header('cache-control', 'no-store')
      .send(bundle);
  });

  app.patch('/api/v1/users/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const existing = await findUserById(deps.pool, id);
    if (!existing) throw problems.notFound();

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid patch', { errors: parsed.error.issues });

    // An admin cannot strip their own admin access — prevents lockouts.
    if (id === principal.id && parsed.data.roles && !parsed.data.roles.some((r) => USER_ADMIN_ROLES.has(r)))
      throw problems.unprocessable('You cannot remove your own admin access');

    // Validate the state the patch would leave behind, not just the patch.
    const nextRoles = parsed.data.roles ?? existing.roles;
    const nextPartnerId = parsed.data.partner_id !== undefined ? parsed.data.partner_id : existing.partner_id;
    assertPartnerScopeConsistent(nextRoles, nextPartnerId);
    if (parsed.data.partner_id && parsed.data.partner_id !== existing.partner_id)
      await assertAssignablePartner(parsed.data.partner_id);

    if (parsed.data.email && parsed.data.email.toLowerCase() !== existing.email.toLowerCase()) {
      if (await findUserByEmail(deps.pool, parsed.data.email))
        throw problems.conflict('An account with this email already exists');
    }

    await adminPatchUser(deps.pool, id, parsed.data);
    const updated = await findUserById(deps.pool, id);
    await audit(principal.id, 'user_updated', 'user', id, existing.email, {
      fields: Object.keys(parsed.data),
      ...(parsed.data.roles ? { roles: parsed.data.roles } : {}),
    });
    return { user: { ...updated, password_digest: undefined } };
  });

  /**
   * Streamlined role promotion (admin-role-management feature A). A convenience
   * wrapper around the PATCH role-update path that is *additive-only*: it adds a
   * single role to the target's current set without the caller needing to know
   * (and re-send) their existing roles, so a stale client can't accidentally
   * drop them. Distinct `user_promoted`/`user_demoted` audit events, too.
   */
  const RoleMutationBody = z.object({ role: z.enum(ROLE_KEYS) });

  app.post('/api/v1/users/:id/promote', { preHandler: app.authenticate }, async (req) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const parsed = RoleMutationBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid role', { errors: parsed.error.issues });
    const { role } = parsed.data;

    const existing = await findUserById(deps.pool, id);
    if (!existing || existing.deleted_at) throw problems.notFound();
    // Idempotent-safe: a double-click returns 409 rather than silently no-op'ing.
    if (existing.roles.includes(role)) throw problems.conflict(`This user already has the ${role} role`);

    const nextRoles = [...existing.roles, role];
    // Additive promotion: only the role *being added* can introduce a scope
    // violation, so validate that role alone — not the target's whole role set.
    // Re-validating the full set would 422 an otherwise-valid admin promotion
    // whenever the user already carries a partner/member role without an
    // organisation (legacy/inconsistent data the admin never touched here).
    assertPartnerScopeConsistent([role], existing.partner_id);

    await adminPatchUser(deps.pool, id, { roles: nextRoles });
    const updated = await findUserById(deps.pool, id);
    await audit(principal.id, 'user_promoted', 'user', id, existing.email, {
      role,
      promoted_by: principal.id,
    });
    return { user: { ...updated, password_digest: undefined } };
  });

  app.post('/api/v1/users/:id/demote', { preHandler: app.authenticate }, async (req) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const parsed = RoleMutationBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid role', { errors: parsed.error.issues });
    const { role } = parsed.data;

    const existing = await findUserById(deps.pool, id);
    if (!existing || existing.deleted_at) throw problems.notFound();
    // Mirrors the PATCH self-lockout guard: an admin can't strip their own tier.
    if (id === principal.id && USER_ADMIN_ROLES.has(role))
      throw problems.unprocessable('You cannot remove your own admin access');
    if (!existing.roles.includes(role)) throw problems.conflict(`This user does not have the ${role} role`);

    const nextRoles = existing.roles.filter((r) => r !== role);
    // Removing a role can never introduce a partner-scope violation, so there
    // is nothing to assert here — validating the remaining set would only
    // wrongly 422 a demotion when the user already held an inconsistent
    // partner/member role, trapping them in that role.

    await adminPatchUser(deps.pool, id, { roles: nextRoles });
    const updated = await findUserById(deps.pool, id);
    await audit(principal.id, 'user_demoted', 'user', id, existing.email, {
      role,
      demoted_by: principal.id,
    });
    return { user: { ...updated, password_digest: undefined } };
  });

  app.delete('/api/v1/users/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    if (id === principal.id) throw problems.unprocessable('You cannot delete your own account');
    const target = await findUserById(deps.pool, id);
    const deleted = await softDeleteUser(deps.pool, id);
    if (!deleted) throw problems.notFound();
    await audit(principal.id, 'user_deactivated', 'user', id, target?.email ?? null);
    return reply.status(204).send();
  });

  // Reactivate a deactivated account (feature #9). Roles were dropped on
  // deactivation, so the admin re-assigns them via PATCH afterwards.
  app.post('/api/v1/users/:id/restore', { preHandler: app.authenticate }, async (req) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const restored = await restoreUser(deps.pool, id);
    if (!restored) throw problems.notFound('No deactivated user with this id');
    const user = await findUserById(deps.pool, id);
    await audit(principal.id, 'user_restored', 'user', id, user?.email ?? null);
    return { user: { ...user, password_digest: undefined } };
  });

  /**
   * Send a password-reset link to a user on their behalf — the support path
   * when someone can't receive the self-service email or is locked out. Unlike
   * /auth/forgot-password this is authenticated, so it may safely 404 on an
   * unknown user and 400 on an SSO account instead of staying silent.
   */
  app.post('/api/v1/users/:id/send-password-reset', { preHandler: app.authenticate }, async (req) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const user = await findUserById(deps.pool, id);
    if (!user || user.deleted_at) throw problems.notFound();
    if (!user.password_digest)
      throw problems.badRequest('This account signs in with Google SSO and has no password');

    const secret = await createPasswordResetToken(deps.pool, user.id);
    const link = `${baseUrl}/reset-password#token=${secret}`;
    const template = passwordResetEmail(link);
    await sendTransactionalEmail(
      { pool: deps.pool, transport: deps.transport, log: req.log },
      { toUserId: user.id, toEmail: user.email, ...template, vars: { link } },
    );
    await audit(principal.id, 'user_password_reset_sent', 'user', id, user.email);
    return { message: `Reset link sent to ${user.email}.` };
  });

  /**
   * Force-sign-out: invalidates every session JWT the user holds. Their API
   * tokens keep working — revoke those individually if that's the intent.
   */
  app.post('/api/v1/users/:id/revoke-sessions', { preHandler: app.authenticate }, async (req) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    // Revoking your own sessions here would 401 you on the next request with
    // no replacement token; /me/sessions/revoke does it properly.
    if (id === principal.id)
      throw problems.unprocessable('Use Settings → sign out everywhere for your own account');
    const user = await findUserById(deps.pool, id);
    if (!user) throw problems.notFound();
    await bumpSessionEpoch(deps.pool, id);
    await audit(principal.id, 'user_sessions_revoked', 'user', id, user.email);
    return { message: `Signed ${user.email} out of all sessions.` };
  });

  // ── Partners (pickers + management console, P1 #7) ─────────────────────────

  /**
   * White-label login branding (improvement 8) — public by design: the login
   * page needs it before any session exists. Exposes nothing beyond what the
   * partner already shows on their own login page.
   */
  app.get('/api/v1/public/partners/:key/branding', async (req) => {
    const { key } = req.params as { key: string };
    if (!/^[a-z0-9-]{1,100}$/.test(key)) throw problems.notFound();
    const branding = await findPartnerBrandingByKey(deps.pool, key);
    if (!branding) throw problems.notFound();
    return { partner: branding };
  });

  app.get('/api/v1/partners', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden();
    const parsed = z
      .object({
        include_archived: flagParam(false),
        q: z.string().trim().min(1).max(200).optional(),
        limit: z.coerce.number().int().min(1).max(PICKER_LIMIT).default(PICKER_LIMIT),
      })
      .safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query');
    return listPartners(deps.pool, {
      includeArchived: parsed.data.include_archived,
      q: parsed.data.q,
      limit: parsed.data.limit,
    });
  });

  /** A partner user's own organisation — name + branding for the portal. */
  app.get('/api/v1/partners/mine', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!principal.partnerId) throw problems.notFound();
    const partner = await findPartnerById(deps.pool, principal.partnerId);
    if (!partner) throw problems.notFound();
    return {
      partner: {
        id: partner.id,
        name: partner.name,
        key: partner.key,
        brand_color: partner.brand_color,
        logo_url: partner.logo_url,
      },
    };
  });

  app.get('/api/v1/partners/:id', { preHandler: app.authenticate }, async (req) => {
    requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const partner = await getPartnerDetail(deps.pool, id);
    if (!partner) throw problems.notFound();
    return { partner };
  });

  app.post('/api/v1/partners', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireUserAdmin(req);
    const parsed = z
      .object({
        name: z.string().min(1).max(200),
        key: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/),
      })
      .safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid partner', { errors: parsed.error.issues });
    try {
      const partner = await createPartner(deps.pool, parsed.data);
      await audit(principal.id, 'partner_created', 'partner', partner.id, partner.name);
      return reply.status(201).send({ partner });
    } catch (err) {
      if (isUniqueViolation(err, 'partners_key_key'))
        throw problems.conflict('A partner with this key already exists');
      throw err;
    }
  });

  app.patch('/api/v1/partners/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const parsed = z
      .object({
        name: z.string().min(1).max(200),
        archived: z.boolean(),
        brand_color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb colour')
          .nullable(),
        logo_url: httpsUrl(2000).nullable(),
        // White-label email overrides (improvement 8): only known workflow
        // template keys; empty subject/body pairs are rejected.
        email_templates: z.record(
          z.enum(PARTNER_EMAIL_TEMPLATE_KEYS),
          z.object({ subject: z.string().min(1).max(300), body: z.string().min(1).max(5000) }),
        ),
        // The firm's public address (0106). Normalised below rather than by a
        // regex here, so a rejection can say *why* — "reserved" and "too
        // short" are different problems with different fixes.
        subdomain: z.string().max(63).nullable(),
        prepaid: z.boolean(),
        // Ten is generous for a shared mailbox and low enough that a paste
        // accident cannot turn one state change into a hundred sends.
        cc_emails: z.array(z.string().email()).max(10),
      })
      .partial()
      .strict()
      .safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid partner', { errors: parsed.error.issues });

    const patch = { ...parsed.data };
    if (patch.subdomain != null) {
      const normalized = normalizeSubdomain(patch.subdomain);
      if ('problem' in normalized)
        throw problems.unprocessable(
          normalized.problem === 'reserved'
            ? `"${patch.subdomain}" is reserved and cannot be used as a subdomain`
            : 'A subdomain must be 3–63 characters of a–z, 0–9 and hyphens, not starting or ending with one',
        );
      patch.subdomain = normalized.subdomain;
    }
    if (patch.cc_emails) {
      // Case-insensitive dedupe: the same mailbox twice is two copies of every
      // email, and "Ops@firm.com" vs "ops@firm.com" is the way it happens.
      const seen = new Set<string>();
      patch.cc_emails = patch.cc_emails.filter((e) => {
        const key = e.toLowerCase();
        return seen.has(key) ? false : (seen.add(key), true);
      });
    }

    let partner;
    try {
      partner = await updatePartner(deps.pool, id, patch);
    } catch (err) {
      // partners_subdomain_key — two firms cannot share an address, and the
      // unique index is the arbiter because two admins can claim the same
      // label in the same second.
      if (isUniqueViolation(err, 'partners_subdomain_key'))
        throw problems.conflict(`The subdomain "${patch.subdomain}" is already taken`);
      throw err;
    }
    if (!partner) throw problems.notFound();
    await audit(principal.id, 'partner_updated', 'partner', partner.id, partner.name, {
      fields: Object.keys(parsed.data),
    });
    return { partner };
  });

  /**
   * A partner's engagements. Reuses `listValuations` with an explicit partner
   * scope rather than the caller's own, so an ops admin sees the firm's list
   * exactly as the firm sees it — which is the point of opening the page.
   */
  app.get('/api/v1/partners/:id/valuations', { preHandler: app.authenticate }, async (req) => {
    requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    if (!(await findPartnerById(deps.pool, id))) throw problems.notFound();

    const parsed = z
      .object({
        state: z.enum(VALUATION_STATES).optional(),
        q: z.string().max(200).optional(),
        page: pageParam(),
        per_page: z.coerce.number().int().min(1).max(100).default(25),
      })
      .safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const q = parsed.data;

    const { items, total } = await listValuations(
      deps.pool,
      { kind: 'partner', partnerId: id },
      { state: q.state, q: q.q, page: q.page, perPage: q.per_page },
    );
    return { valuations: items, page: q.page, per_page: q.per_page, total };
  });

  // ── Roles & capabilities ───────────────────────────────────────────────────

  /**
   * The role catalog with its capability matrix. Served rather than hard-coded
   * in the frontend because it is the answer to "what am I granting", and an
   * admin assigning one of eighteen roles from a dropdown of bare keys is
   * choosing without being told.
   */
  app.get('/api/v1/roles', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden();
    return { roles: ROLE_DEFS, capabilities: CAPABILITIES };
  });

  /** What the signed-in user may do — what the frontend hides its nav on. */
  app.get('/api/v1/me/capabilities', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    return { roles: principal.roles, capabilities: capabilitiesFor(principal) };
  });
}
