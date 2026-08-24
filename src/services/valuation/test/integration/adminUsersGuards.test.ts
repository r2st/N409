import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The admin console's guard rails — the checks that stop an administrator
 * locking themselves out, assigning a scope that means nothing, or acting on an
 * account that is not there.
 *
 * `routes/adminUsers.ts` held more uncovered branches than any other file in the
 * service (43), and almost all of them were these. That is the wrong half to
 * leave untested: the happy paths here are ordinary CRUD, while the refusals are
 * the entire security model of the console. A promote route that silently
 * dropped a role, or a delete that let the last admin remove themselves, would
 * pass every test that only checks the console works.
 */
describe.skipIf(!dbUp)('admin console — guard rails', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let otherAdmin: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;

  const ULID_ABSENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    otherAdmin = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    partnerId = await seedPartner(ctx, 'Guards LLP');
  });
  afterAll(async () => ctx?.teardown());

  const auth = () => authHeader(admin.token);
  let seq = 0;
  const email = () => `guard.${(seq += 1)}.${Date.now()}@example.com`;

  async function createUser(over: Record<string, unknown> = {}) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: auth(),
      payload: { email: email(), password: 'correct-horse-battery-9', roles: ['valuation_user'], ...over },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().user as { id: string; email: string; roles: string[] };
  }

  // ── Self-lockout ──────────────────────────────────────────────────────────
  describe('an admin cannot lock themselves out', () => {
    it('422s a patch that strips the caller of every admin role', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${admin.id}`,
        headers: auth(),
        payload: { roles: ['valuation_user'] },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/your own admin access/i);
    });

    it('allows a patch that swaps one admin role for another', async () => {
      // The guard is about the *tier*, not the exact role. Moving admin → god
      // leaves the caller able to undo what they just did, which is the whole
      // property being protected.
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${admin.id}`,
        headers: auth(),
        payload: { roles: ['admin', 'supervisor'] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.roles).toContain('supervisor');
      // Put it back so later cases see the original set.
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${admin.id}`,
        headers: auth(),
        payload: { roles: ['admin'] },
      });
    });

    it('422s demoting yourself out of the admin tier, but allows demoting another admin', async () => {
      const self = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${admin.id}/demote`,
        headers: auth(),
        payload: { role: 'admin' },
      });
      expect(self.statusCode).toBe(422);
      expect(self.json().detail).toMatch(/your own admin access/i);

      const other = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${otherAdmin.id}/demote`,
        headers: auth(),
        payload: { role: 'admin' },
      });
      expect(other.statusCode).toBe(200);
      expect(other.json().user.roles).not.toContain('admin');
    });

    it('422s deleting your own account', async () => {
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${admin.id}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/your own account/i);
    });

    it('422s revoking your own sessions here, pointing at the route that does it properly', async () => {
      // Doing it here would 401 the caller on their next request with no
      // replacement token — a self-inflicted lockout with no error to read.
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${admin.id}/revoke-sessions`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/sign out everywhere/i);
    });
  });

  // ── Partner scope ─────────────────────────────────────────────────────────
  describe('partner scope', () => {
    it('422s a partner or member role with no organisation', async () => {
      // Scoped to nothing is not a lesser scope, it is an undefined one: every
      // partner query filters on partner_id, so the account would see nothing
      // and the admin would think they had granted access.
      for (const role of ['partner', 'member']) {
        const created = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/users',
          headers: auth(),
          payload: { email: email(), password: 'correct-horse-battery-9', roles: [role] },
        });
        expect(created.statusCode, role).toBe(422);
        expect(created.json().detail).toMatch(/require a partner organisation/i);

        const invited = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/users/invite',
          headers: auth(),
          payload: { email: email(), roles: [role] },
        });
        expect(invited.statusCode, role).toBe(422);
      }
    });

    it('422s a patch that would leave the user partner-scoped to nothing', async () => {
      // Validates the state the patch *would leave behind*, not the patch: the
      // user keeps their partner role, so detaching the organisation on its own
      // is the same inconsistency reached from the other side.
      const user = await createUser({ roles: ['partner'], partner_id: partnerId });
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${user.id}`,
        headers: auth(),
        payload: { partner_id: null },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/require a partner organisation/i);
    });

    it('422s an unknown or archived partner on create, invite and patch', async () => {
      const archived = await seedPartner(ctx, 'Archived LLP');
      await ctx.pool.query('UPDATE partners SET archived_at = now() WHERE id = $1', [archived]);

      const cases: [string, string][] = [
        ['unknown', ULID_ABSENT],
        ['malformed', 'not-a-ulid'],
        ['archived', archived],
      ];
      for (const [label, id] of cases) {
        const created = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/users',
          headers: auth(),
          payload: {
            email: email(),
            password: 'correct-horse-battery-9',
            roles: ['partner'],
            partner_id: id,
          },
        });
        expect(created.statusCode, `create ${label}`).toBe(422);
        // The issue path names the field, so the console can highlight it.
        expect(created.json().errors?.[0]?.path).toEqual(['partner_id']);

        const invited = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/users/invite',
          headers: auth(),
          payload: { email: email(), roles: ['partner'], partner_id: id },
        });
        expect(invited.statusCode, `invite ${label}`).toBe(422);
      }
    });

    it('only re-checks the partner on patch when the patch actually moves it', async () => {
      const user = await createUser({ roles: ['partner'], partner_id: partnerId });
      // Re-sending the same partner id is not a move, so the assignable check
      // is skipped — otherwise archiving a partner would freeze every unrelated
      // edit to the accounts already inside it.
      await ctx.pool.query('UPDATE partners SET archived_at = now() WHERE id = $1', [partnerId]);
      try {
        const res = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/users/${user.id}`,
          headers: auth(),
          payload: { partner_id: partnerId, first_name: 'Renamed' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().user.first_name).toBe('Renamed');
      } finally {
        await ctx.pool.query('UPDATE partners SET archived_at = NULL WHERE id = $1', [partnerId]);
      }
    });
  });

  // ── Promote / demote ──────────────────────────────────────────────────────
  describe('promote and demote', () => {
    it('adds a role without needing the caller to resend the existing set', async () => {
      // The point of the route: a stale console cannot drop roles it did not
      // know about, because it never sends the whole set.
      const user = await createUser({ roles: ['valuation_user'] });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/promote`,
        headers: auth(),
        payload: { role: 'reviewer' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.roles.sort()).toEqual(['reviewer', 'valuation_user']);
    });

    it("409s promoting a role the user already has, rather than no-op'ing", async () => {
      // A double-click should not read as success — the admin is entitled to
      // know the second click did nothing.
      const user = await createUser({ roles: ['reviewer'] });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/promote`,
        headers: auth(),
        payload: { role: 'reviewer' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toMatch(/already has the reviewer role/);
    });

    it('409s demoting a role the user does not have', async () => {
      const user = await createUser({ roles: ['valuation_user'] });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/demote`,
        headers: auth(),
        payload: { role: 'reviewer' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toMatch(/does not have the reviewer role/);
    });

    it('422s promoting to a partner role when the user has no organisation', async () => {
      const user = await createUser({ roles: ['valuation_user'] });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/promote`,
        headers: auth(),
        payload: { role: 'partner' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('validates only the role being added, not the set already there', async () => {
      // A user carrying a partner role with no organisation is data an admin
      // never entered through this console. Re-validating the whole set would
      // 422 an unrelated promotion and trap them in that state.
      const user = await createUser({ roles: ['valuation_user'] });
      // Roles live in `user_roles`, so the inconsistency is written the only
      // way it could arise in production: a role row with no organisation.
      await ctx.pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE key = 'partner'
         ON CONFLICT DO NOTHING`,
        [user.id],
      );
      await ctx.pool.query('UPDATE users SET partner_id = NULL WHERE id = $1', [user.id]);
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/promote`,
        headers: auth(),
        payload: { role: 'reviewer' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.roles).toContain('reviewer');
    });

    it('lets a demotion out of an inconsistent state through for the same reason', async () => {
      const user = await createUser({ roles: ['valuation_user'] });
      // Roles live in `user_roles`, so the inconsistency is written the only
      // way it could arise in production: a role row with no organisation.
      await ctx.pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE key = 'partner'
         ON CONFLICT DO NOTHING`,
        [user.id],
      );
      await ctx.pool.query('UPDATE users SET partner_id = NULL WHERE id = $1', [user.id]);
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/demote`,
        headers: auth(),
        payload: { role: 'partner' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.roles).not.toContain('partner');
    });

    it('422s a role that is not in the vocabulary, and 404s a deactivated target', async () => {
      const user = await createUser();
      const badRole = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/promote`,
        headers: auth(),
        payload: { role: 'wizard' },
      });
      expect(badRole.statusCode).toBe(422);

      await ctx.app.inject({ method: 'DELETE', url: `/api/v1/users/${user.id}`, headers: auth() });
      for (const action of ['promote', 'demote']) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/users/${user.id}/${action}`,
          headers: auth(),
          payload: { role: 'reviewer' },
        });
        expect(res.statusCode, action).toBe(404);
      }
    });
  });

  // ── Invitations ───────────────────────────────────────────────────────────
  describe('invitations', () => {
    it('409s inviting an address that already has an account or a pending invite', async () => {
      const user = await createUser();
      const dup = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users/invite',
        headers: auth(),
        payload: { email: user.email, roles: ['valuation_user'] },
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().detail).toMatch(/already exists/i);

      const fresh = email();
      const first = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users/invite',
        headers: auth(),
        payload: { email: fresh, roles: ['valuation_user'] },
      });
      expect(first.statusCode).toBe(201);
      const second = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users/invite',
        headers: auth(),
        payload: { email: fresh, roles: ['valuation_user'] },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().detail).toMatch(/already pending/i);
    });

    it('404s resend and revoke on a malformed id, and 409/404 once it is gone', async () => {
      for (const id of ['not-a-ulid']) {
        const resend = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/users/invitations/${id}/resend`,
          headers: auth(),
        });
        expect(resend.statusCode).toBe(404);
        const revoke = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/users/invitations/${id}`,
          headers: auth(),
        });
        expect(revoke.statusCode).toBe(404);
      }

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users/invite',
        headers: auth(),
        payload: { email: email(), roles: ['valuation_user'] },
      });
      const invitationId = created.json().invitation.id as string;

      const revoked = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/users/invitations/${invitationId}`,
        headers: auth(),
      });
      expect(revoked.statusCode).toBe(204);

      // Revoking twice is a 404 — there is no pending invitation left.
      const again = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/users/invitations/${invitationId}`,
        headers: auth(),
      });
      expect(again.statusCode).toBe(404);

      // Resending a revoked invitation is a 409, not a 404: the row exists,
      // it is simply no longer in a state that can be resent.
      const resend = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/invitations/${invitationId}/resend`,
        headers: auth(),
      });
      expect(resend.statusCode).toBe(409);
      expect(resend.json().detail).toMatch(/already accepted or revoked/i);
    });

    it('422s an invitation to something that is not an email address', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users/invite',
        headers: auth(),
        payload: { email: 'not-an-email', roles: ['valuation_user'] },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  describe('deactivate and restore', () => {
    it('404s restoring a user who was never deactivated, and 404s an unknown id', async () => {
      const user = await createUser();
      const live = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/restore`,
        headers: auth(),
      });
      expect(live.statusCode).toBe(404);
      expect(live.json().detail).toMatch(/no deactivated user/i);

      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/users/${id}/restore`,
          headers: auth(),
        });
        expect(res.statusCode, id).toBe(404);
      }
    });

    it('restores a deactivated account, and lets the address be reinvited only after', async () => {
      const user = await createUser();
      await ctx.app.inject({ method: 'DELETE', url: `/api/v1/users/${user.id}`, headers: auth() });

      // A deactivated account no longer blocks its own address — the invite
      // conflict checks `!deleted_at` for exactly this case.
      const reinvite = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users/invite',
        headers: auth(),
        payload: { email: user.email, roles: ['valuation_user'] },
      });
      expect(reinvite.statusCode).toBe(201);

      const restored = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/restore`,
        headers: auth(),
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().user.deleted_at).toBeNull();
    });

    it('404s deleting an id that is malformed or already gone', async () => {
      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        const res = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/users/${id}`,
          headers: auth(),
        });
        expect(res.statusCode, id).toBe(404);
      }
    });
  });

  // ── Password reset on behalf ──────────────────────────────────────────────
  describe('admin-initiated password reset', () => {
    it('400s an SSO account that has no password to reset', async () => {
      // Authenticated, so it may say so plainly — unlike /auth/forgot-password,
      // which must stay silent to avoid confirming an address exists.
      const user = await createUser();
      // `users_auth_method` requires one of password/SSO/provisioned, so an
      // account with no password must name the provider it signs in with.
      await ctx.pool.query(`UPDATE users SET password_digest = NULL, sso_provider = 'google' WHERE id = $1`, [
        user.id,
      ]);
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/send-password-reset`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toMatch(/Google SSO/);
    });

    it('404s an unknown, malformed or deactivated account', async () => {
      const user = await createUser();
      await ctx.app.inject({ method: 'DELETE', url: `/api/v1/users/${user.id}`, headers: auth() });
      for (const id of ['not-a-ulid', ULID_ABSENT, user.id]) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/users/${id}/send-password-reset`,
          headers: auth(),
        });
        expect(res.statusCode, id).toBe(404);
      }
    });

    it('sends the link for a live password account', async () => {
      const user = await createUser();
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${user.id}/send-password-reset`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toContain(user.email);
    });
  });

  // ── Queries and bodies ────────────────────────────────────────────────────
  describe('list queries', () => {
    it('400s a page size, page number or role filter outside its range', async () => {
      for (const q of ['per_page=0', 'per_page=101', 'page=0', 'role=wizard', 'q=' + 'x'.repeat(201)]) {
        for (const path of ['/api/v1/users', '/api/v1/users/export']) {
          const res = await ctx.app.inject({ method: 'GET', url: `${path}?${q}`, headers: auth() });
          expect(res.statusCode, `${path}?${q}`).toBe(400);
        }
      }
    });

    it('422s a create with a short password or a bad address', async () => {
      for (const payload of [
        { email: email(), password: 'short', roles: ['valuation_user'] },
        { email: 'nope', password: 'correct-horse-battery-9', roles: ['valuation_user'] },
        { email: email(), password: 'correct-horse-battery-9', roles: ['wizard'] },
      ]) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/users',
          headers: auth(),
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
    });

    it('409s a create whose address is taken, and a patch that moves onto a taken one', async () => {
      const a = await createUser();
      const b = await createUser();

      const dup = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: auth(),
        payload: { email: a.email, password: 'correct-horse-battery-9', roles: ['valuation_user'] },
      });
      expect(dup.statusCode).toBe(409);

      const collide = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${b.id}`,
        headers: auth(),
        payload: { email: a.email },
      });
      expect(collide.statusCode).toBe(409);

      // Re-sending your own address in a different case is not a collision.
      const sameCase = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${b.id}`,
        headers: auth(),
        payload: { email: b.email.toUpperCase() },
      });
      expect(sameCase.statusCode).toBe(200);
    });

    it('404s a patch against a malformed or absent id', async () => {
      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        const res = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/users/${id}`,
          headers: auth(),
          payload: { first_name: 'X' },
        });
        expect(res.statusCode, id).toBe(404);
      }
    });
  });

  // ── Authorisation ─────────────────────────────────────────────────────────
  it('forbids a non-admin on every console route', async () => {
    const routes: [string, string][] = [
      ['POST', '/api/v1/users/invite'],
      ['GET', '/api/v1/users/invitations'],
      ['POST', `/api/v1/users/invitations/${ULID_ABSENT}/resend`],
      ['DELETE', `/api/v1/users/invitations/${ULID_ABSENT}`],
      ['GET', '/api/v1/users'],
      ['GET', '/api/v1/users/export'],
      ['POST', '/api/v1/users'],
      ['PATCH', `/api/v1/users/${ULID_ABSENT}`],
      ['POST', `/api/v1/users/${ULID_ABSENT}/promote`],
      ['POST', `/api/v1/users/${ULID_ABSENT}/demote`],
      ['DELETE', `/api/v1/users/${ULID_ABSENT}`],
      ['POST', `/api/v1/users/${ULID_ABSENT}/restore`],
      ['POST', `/api/v1/users/${ULID_ABSENT}/send-password-reset`],
      ['POST', `/api/v1/users/${ULID_ABSENT}/revoke-sessions`],
    ];
    for (const [method, url] of routes) {
      const res = await ctx.app.inject({
        method: method as 'GET',
        url,
        headers: authHeader(client.token),
        payload: method === 'GET' ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
