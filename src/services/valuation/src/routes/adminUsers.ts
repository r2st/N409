import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canManageUsers, isOps } from '../auth/rbac.js';
import { ROLE_KEYS, USER_ADMIN_ROLES } from '../domain/roles.js';
import { toCsv } from '../domain/csv.js';
import { hashPassword } from '../auth/password.js';
import { createUser, findUserByEmail, findUserById } from '../repos/users.js';
import {
  adminPatchUser,
  createPartner,
  listPartners,
  listUserOptions,
  listUsers,
  softDeleteUser,
  type AdminUserRow,
} from '../repos/adminUsers.js';
import { requirePrincipal } from '../plugins/auth.js';

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  role: z.enum(ROLE_KEYS).optional(),
  partner_id: z.string().optional(),
  include_deleted: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

const CreateBody = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'password must be at least 10 characters'),
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  partner_id: z.string().nullable().optional(),
  verified: z.boolean().optional(),
  roles: z.array(z.enum(ROLE_KEYS)).min(1),
});

const PatchBody = z
  .object({
    email: z.string().email(),
    first_name: z.string().max(100).nullable(),
    last_name: z.string().max(100).nullable(),
    phone: z.string().max(50).nullable(),
    verified: z.boolean(),
    partner_id: z.string().nullable(),
    roles: z.array(z.enum(ROLE_KEYS)),
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
    verified: u.verified,
    sso_provider: u.sso_provider,
    partner_id: u.partner_id,
    partner_name: u.partner_name ?? null,
    roles: u.roles,
    created_at: u.created_at,
    deleted_at: u.deleted_at,
  };
}

/** M3 feature 13 — user/role admin console (+ feature 16: users CSV export). */
export function registerAdminUserRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const requireUserAdmin = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal)) throw problems.forbidden();
    return principal;
  };

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

    const { items } = await listUsers(deps.pool, {
      q,
      role,
      partnerId: partner_id,
      includeDeleted: include_deleted,
      page: 1,
      perPage: 10_000,
    });
    const columns = [
      'id',
      'email',
      'first_name',
      'last_name',
      'phone',
      'verified',
      'roles',
      'partner_name',
      'sso_provider',
      'created_at',
      'deleted_at',
    ];
    const csv = toCsv(columns, items as unknown as Array<Record<string, unknown>>);
    return reply
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
    const parsed = z.object({ group: z.enum(['ops', 'partner']).default('ops') }).safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query');
    return { options: await listUserOptions(deps.pool, parsed.data.group) };
  });

  app.post('/api/v1/users', { preHandler: app.authenticate }, async (req, reply) => {
    requireUserAdmin(req);
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid user', { errors: parsed.error.issues });
    const body = parsed.data;

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
    return reply.status(201).send({ user: { ...user, password_digest: undefined } });
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

    if (parsed.data.email && parsed.data.email.toLowerCase() !== existing.email.toLowerCase()) {
      if (await findUserByEmail(deps.pool, parsed.data.email))
        throw problems.conflict('An account with this email already exists');
    }

    await adminPatchUser(deps.pool, id, parsed.data);
    const updated = await findUserById(deps.pool, id);
    return { user: { ...updated, password_digest: undefined } };
  });

  app.delete('/api/v1/users/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireUserAdmin(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    if (id === principal.id) throw problems.unprocessable('You cannot delete your own account');
    const deleted = await softDeleteUser(deps.pool, id);
    if (!deleted) throw problems.notFound();
    return reply.status(204).send();
  });

  // ── Partners (pickers + creation for the admin console) ───────────────────
  app.get('/api/v1/partners', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden();
    return { partners: await listPartners(deps.pool) };
  });

  app.post('/api/v1/partners', { preHandler: app.authenticate }, async (req, reply) => {
    requireUserAdmin(req);
    const parsed = z
      .object({ name: z.string().min(1).max(200), key: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/) })
      .safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid partner', { errors: parsed.error.issues });
    try {
      const partner = await createPartner(deps.pool, parsed.data);
      return reply.status(201).send({ partner });
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw problems.conflict('A partner with this key already exists');
      throw err;
    }
  });
}
