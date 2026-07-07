import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('M3 operations API', () => {
  let ctx: TestApp;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;
  let partnerAdmin: Awaited<ReturnType<typeof seedUser>>;
  let partnerMember: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;
  let otherPartnerId: string;

  const createValuation = async (token: string, body: Record<string, unknown>) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: 'Acme', ...body },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation as { id: string; number: string };
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    partnerId = await seedPartner(ctx, 'Vestd');
    otherPartnerId = await seedPartner(ctx, 'Carta');
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    otherClient = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
    reviewer = await seedUser(ctx, { roles: ['reviewer'] });
    partnerAdmin = await seedUser(ctx, { roles: ['partner'], partnerId });
    partnerMember = await seedUser(ctx, { roles: ['member'], partnerId });
  });
  afterAll(async () => ctx?.teardown());

  // ── Features 10 + 11: chat, sticky notes, email threading ─────────────────
  describe('comments: chat + sticky notes', () => {
    let valuationId: string;

    beforeAll(async () => {
      valuationId = (await createValuation(client.token, { company_name: 'ChatCo' })).id;
    });

    it('lets the owner post chat and read it back', async () => {
      const post = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(client.token),
        payload: { kind: 'chat', body: 'When is the draft due?' },
      });
      expect(post.statusCode).toBe(201);
      expect(post.json().comment.kind).toBe('chat');

      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(client.token),
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().comments).toHaveLength(1);
      expect(list.json().comments[0].author_email).toBe(client.email);
    });

    it('bumps last_comment_at on the valuation', async () => {
      const { rows } = await ctx.pool.query(
        'SELECT last_comment_at FROM valuations WHERE id = $1',
        [valuationId],
      );
      expect(rows[0].last_comment_at).not.toBeNull();
    });

    it('forbids clients from posting sticky notes', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(client.token),
        payload: { kind: 'note', body: 'sneaky' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('lets ops post pinned sticky notes that clients never see', async () => {
      const post = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(ops.token),
        payload: { kind: 'note', body: 'Cap table needs re-check', pinned: true },
      });
      expect(post.statusCode).toBe(201);
      expect(post.json().comment.pinned).toBe(true);

      const opsList = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(ops.token),
      });
      expect(opsList.json().comments.map((c: { kind: string }) => c.kind).sort()).toEqual([
        'chat',
        'note',
      ]);

      const clientList = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(client.token),
      });
      expect(clientList.json().comments.map((c: { kind: string }) => c.kind)).toEqual(['chat']);

      // and asking for notes explicitly is forbidden
      const sneaky = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/comments?kind=note`,
        headers: authHeader(client.token),
      });
      expect(sneaky.statusCode).toBe(403);
    });

    it('hides other clients’ valuations entirely (404)', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(otherClient.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('author edits own comment; strangers cannot', async () => {
      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/comments?kind=chat`,
        headers: authHeader(client.token),
      });
      const commentId = list.json().comments[0].id as string;

      const edit = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/comments/${commentId}`,
        headers: authHeader(client.token),
        payload: { body: 'When is the draft due? (edited)' },
      });
      expect(edit.statusCode).toBe(200);
      expect(edit.json().comment.body).toContain('(edited)');

      const strangerEdit = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/comments/${commentId}`,
        headers: authHeader(otherClient.token),
        payload: { body: 'hijack' },
      });
      expect(strangerEdit.statusCode).toBe(404); // can't even see the valuation
    });

    it('ops can moderate (delete) a chat message', async () => {
      const post = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(client.token),
        payload: { kind: 'chat', body: 'to be removed' },
      });
      const commentId = post.json().comment.id as string;
      const del = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/comments/${commentId}`,
        headers: authHeader(ops.token),
      });
      expect(del.statusCode).toBe(204);
    });

    it('writes comment events to the audit spine', async () => {
      const events = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/events`,
        headers: authHeader(ops.token),
      });
      const types = events.json().events.map((e: { type: string }) => e.type);
      expect(types).toContain('comment_added');
    });
  });

  describe('email inbox → comment threading', () => {
    let valuationId: string;
    let valuationNumber: string;

    beforeAll(async () => {
      const v = await createValuation(client.token, { company_name: 'MailCo' });
      valuationId = v.id;
      valuationNumber = String(v.number);
    });

    it('threads an email by ULID in the subject, idempotently', async () => {
      const payload = {
        from: 'someone@example.com',
        subject: `Re: valuation ${valuationId}`,
        body: 'Attached the cap table.',
        message_id: '<msg-1@mail.example.com>',
      };
      const first = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/inbox/email',
        headers: authHeader(ops.token),
        payload,
      });
      expect(first.statusCode).toBe(201);
      expect(first.json().valuation_id).toBe(valuationId);
      expect(first.json().comment.kind).toBe('email');

      const replay = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/inbox/email',
        headers: authHeader(ops.token),
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().created).toBe(false);
      expect(replay.json().comment.id).toBe(first.json().comment.id);
    });

    it('threads by #number in the subject', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/inbox/email',
        headers: authHeader(ops.token),
        payload: {
          from: 'someone@example.com',
          subject: `Question about #${valuationNumber}`,
          body: 'Quick question.',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().valuation_id).toBe(valuationId);
    });

    it('falls back to the sender’s latest valuation', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/inbox/email',
        headers: authHeader(ops.token),
        payload: { from: client.email, subject: 'no reference here', body: 'Hello!' },
      });
      expect(res.statusCode).toBe(201);
    });

    it('rejects unmatchable email with 422 and non-ops with 403', async () => {
      const unmatched = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/inbox/email',
        headers: authHeader(ops.token),
        payload: { from: 'stranger@nowhere.io', subject: 'hi', body: 'no ref' },
      });
      expect(unmatched.statusCode).toBe(422);

      const forbidden = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/inbox/email',
        headers: authHeader(client.token),
        payload: { from: client.email, subject: 'x', body: 'y' },
      });
      expect(forbidden.statusCode).toBe(403);
    });

    it('email comments are ops-only in the thread', async () => {
      const clientList = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(client.token),
      });
      expect(
        clientList.json().comments.every((c: { kind: string }) => c.kind === 'chat'),
      ).toBe(true);
    });
  });

  // ── Feature 14: partner API tokens ─────────────────────────────────────────
  describe('partner API tokens', () => {
    let secret: string;
    let tokenId: string;

    it('partner org admin mints a token (secret shown once)', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/partners/${partnerId}/tokens`,
        headers: authHeader(partnerAdmin.token),
        payload: { name: 'CI integration' },
      });
      expect(res.statusCode).toBe(201);
      secret = res.json().secret;
      tokenId = res.json().token.id;
      expect(secret.startsWith('n409_pat_')).toBe(true);
      expect(res.json().token.token_hash).toBeUndefined();
    });

    it('members and other partners cannot manage tokens', async () => {
      const member = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/partners/${partnerId}/tokens`,
        headers: authHeader(partnerMember.token),
        payload: { name: 'nope' },
      });
      expect(member.statusCode).toBe(403);

      const cross = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/partners/${otherPartnerId}/tokens`,
        headers: authHeader(partnerAdmin.token),
      });
      expect(cross.statusCode).toBe(403);
    });

    it('the secret authenticates with partner scope', async () => {
      await createValuation(partnerAdmin.token, { company_name: 'PartnerDeal' });
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations',
        headers: authHeader(secret),
      });
      expect(res.statusCode).toBe(200);
      const companies = res.json().valuations.map((v: { company_name: string }) => v.company_name);
      expect(companies).toContain('PartnerDeal');
      expect(companies).not.toContain('ChatCo'); // client-owned, out of partner scope
    });

    it('records last_used_at and revokes cleanly', async () => {
      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/partners/${partnerId}/tokens`,
        headers: authHeader(partnerAdmin.token),
      });
      const minted = list.json().tokens.find((t: { id: string }) => t.id === tokenId);
      expect(minted.last_used_at).not.toBeNull();

      const revoke = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/api-tokens/${tokenId}`,
        headers: authHeader(partnerAdmin.token),
      });
      expect(revoke.statusCode).toBe(204);

      const after = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations',
        headers: authHeader(secret),
      });
      expect(after.statusCode).toBe(401);
    });

    it('ops can mint tokens for any partner', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/partners/${otherPartnerId}/tokens`,
        headers: authHeader(ops.token),
        payload: { name: 'ops-provisioned' },
      });
      expect(res.statusCode).toBe(201);
    });
  });

  // ── Feature 13: user/role admin console ────────────────────────────────────
  describe('admin console', () => {
    it('is admin-roles only', async () => {
      for (const token of [client.token, partnerAdmin.token, reviewer.token]) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/users',
          headers: authHeader(token),
        });
        expect(res.statusCode).toBe(403);
      }
    });

    it('lists users with roles and partner names, filterable', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/users?q=${encodeURIComponent(partnerAdmin.email)}`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(1);
      expect(res.json().users[0].roles).toEqual(['partner']);
      expect(res.json().users[0].partner_name).toBe('Vestd');
      expect(res.json().users[0].password_digest).toBeUndefined();

      const byRole = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/users?role=member',
        headers: authHeader(ops.token),
      });
      expect(
        byRole.json().users.every((u: { roles: string[] }) => u.roles.includes('member')),
      ).toBe(true);
    });

    it('creates a user with roles', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: authHeader(ops.token),
        payload: {
          email: 'new.reviewer@n409.test',
          password: 'a-long-password',
          first_name: 'Nia',
          roles: ['reviewer'],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().user.roles).toEqual(['reviewer']);

      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'new.reviewer@n409.test', password: 'a-long-password' },
      });
      expect(login.statusCode).toBe(200);
    });

    it('updates fields and replaces roles', async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: authHeader(ops.token),
        payload: { email: 'temp.user@n409.test', password: 'a-long-password', roles: ['valuation_user'] },
      });
      const id = created.json().user.id as string;

      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${id}`,
        headers: authHeader(ops.token),
        payload: { first_name: 'Temp', roles: ['support', 'reviewer'], partner_id: partnerId },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().user.first_name).toBe('Temp');
      expect([...patch.json().user.roles].sort()).toEqual(['reviewer', 'support']);
      expect(patch.json().user.partner_id).toBe(partnerId);
    });

    it('blocks removing your own admin access and self-deletion', async () => {
      const lockout = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${ops.id}`,
        headers: authHeader(ops.token),
        payload: { roles: ['valuation_user'] },
      });
      expect(lockout.statusCode).toBe(422);

      const selfDelete = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${ops.id}`,
        headers: authHeader(ops.token),
      });
      expect(selfDelete.statusCode).toBe(422);
    });

    it('soft-deletes: user disappears from the list and cannot sign in', async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: authHeader(ops.token),
        payload: { email: 'leaver@n409.test', password: 'a-long-password', roles: ['valuation_user'] },
      });
      const id = created.json().user.id as string;

      const del = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${id}`,
        headers: authHeader(ops.token),
      });
      expect(del.statusCode).toBe(204);

      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/users?q=leaver@n409.test',
        headers: authHeader(ops.token),
      });
      expect(list.json().total).toBe(0);

      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'leaver@n409.test', password: 'a-long-password' },
      });
      expect(login.statusCode).toBe(401);
    });

    it('exports users as CSV', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/users/export',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.body.split('\r\n')[0]).toContain('id,email');
      expect(res.body).toContain(ops.email);
    });

    it('serves picker options to ops and manages partners', async () => {
      const options = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/users/options?group=ops',
        headers: authHeader(reviewer.token), // any ops role, not just admins
      });
      expect(options.statusCode).toBe(200);
      expect(options.json().options.some((o: { id: string }) => o.id === reviewer.id)).toBe(true);

      const partner = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/partners',
        headers: authHeader(ops.token),
        payload: { name: 'SeedLegals', key: 'seedlegals' },
      });
      expect(partner.statusCode).toBe(201);

      const partners = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/partners',
        headers: authHeader(ops.token),
      });
      expect(partners.json().partners.map((p: { key: string }) => p.key)).toContain('seedlegals');
    });

    // ── P0 #1: partner admin page — rollup counts + rename ──────────────────
    it('lists partners with rollup counts and renames a partner', async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/partners',
        headers: authHeader(ops.token),
        payload: { name: 'Ledgy', key: 'ledgy' },
      });
      expect(created.statusCode).toBe(201);
      const pid = created.json().partner.id as string;
      expect(created.json().partner.user_count).toBe(0);
      expect(created.json().partner.valuation_count).toBe(0);

      await seedUser(ctx, { roles: ['partner'], partnerId: pid });

      const partners = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/partners',
        headers: authHeader(ops.token),
      });
      const row = partners
        .json()
        .partners.find((p: { id: string }) => p.id === pid) as {
        user_count: number;
        valuation_count: number;
      };
      expect(row.user_count).toBe(1);
      expect(row.valuation_count).toBe(0);

      const renamed = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/partners/${pid}`,
        headers: authHeader(ops.token),
        payload: { name: 'Ledgy Ltd' },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().partner.name).toBe('Ledgy Ltd');
      expect(renamed.json().partner.key).toBe('ledgy'); // keys are immutable
      expect(renamed.json().partner.user_count).toBe(1);
    });

    it('guards partner management behind the right roles', async () => {
      // A reviewer is ops (can read the picker list) but not a user admin.
      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/partners',
        headers: authHeader(reviewer.token),
      });
      expect(list.statusCode).toBe(200);

      const create = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/partners',
        headers: authHeader(reviewer.token),
        payload: { name: 'Nope', key: 'nope' },
      });
      expect(create.statusCode).toBe(403);

      const rename = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/partners/${partnerId}`,
        headers: authHeader(reviewer.token),
        payload: { name: 'Nope' },
      });
      expect(rename.statusCode).toBe(403);

      // Clients see nothing at all.
      const clientList = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/partners',
        headers: authHeader(client.token),
      });
      expect(clientList.statusCode).toBe(403);

      // Unknown/invalid ids and empty names are rejected.
      const missing = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/partners/${newUlid()}`,
        headers: authHeader(ops.token),
        payload: { name: 'Ghost' },
      });
      expect(missing.statusCode).toBe(404);

      const invalid = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/partners/${partnerId}`,
        headers: authHeader(ops.token),
        payload: { name: '' },
      });
      expect(invalid.statusCode).toBe(422);
    });
  });

  // ── Features 15–17: filtering, counts, CSV, dashboard analytics ───────────
  describe('advanced filtering + counts + export + stats', () => {
    let filterClient: Awaited<ReturnType<typeof seedUser>>;
    let published: { id: string; number: string };

    beforeAll(async () => {
      filterClient = await seedUser(ctx, { roles: ['valuation_user'] });
      published = await createValuation(filterClient.token, { company_name: 'Zebra Systems' });
      await createValuation(filterClient.token, { kind: 'esop', company_name: 'Yak Industries' });

      // move one to published + assign reviewer (ops-only patch); the publish
      // gate requires the main signature first
      const signed = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${published.id}/signatures`,
        headers: authHeader(ops.token),
        payload: { role: 'main', signer_name: 'Ops Reviewer', signature_text: '/s/ Ops Reviewer' },
      });
      expect(signed.statusCode).toBe(201);
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${published.id}`,
        headers: authHeader(ops.token),
        payload: { state: 'published', assigned_reviewer_id: reviewer.id },
      });
      expect(patch.statusCode).toBe(200);
    });

    it('searches by engagement number, ULID and company substring', async () => {
      const byNumber = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations?q=${published.number}`,
        headers: authHeader(ops.token),
      });
      expect(byNumber.json().total).toBe(1);
      expect(byNumber.json().valuations[0].id).toBe(published.id);

      const byUlid = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations?q=${published.id.toLowerCase()}`,
        headers: authHeader(ops.token),
      });
      expect(byUlid.json().total).toBe(1);

      const byName = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?q=zebra',
        headers: authHeader(ops.token),
      });
      expect(byName.json().total).toBe(1);
      expect(byName.json().valuations[0].company_name).toBe('Zebra Systems');
    });

    it('filters by reviewer, state group and date range', async () => {
      const byReviewer = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations?reviewer_id=${reviewer.id}`,
        headers: authHeader(ops.token),
      });
      expect(byReviewer.json().total).toBe(1);

      const byGroup = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?group=published&q=zebra',
        headers: authHeader(ops.token),
      });
      expect(byGroup.json().total).toBe(1);

      const past = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?created_to=2000-01-01',
        headers: authHeader(ops.token),
      });
      expect(past.json().total).toBe(0);

      const today = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?created_from=2000-01-01&q=zebra',
        headers: authHeader(ops.token),
      });
      expect(today.json().total).toBe(1);
    });

    it('returns live tab counts honouring the other filters', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/counts?user_id=${filterClient.id}`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().counts.all).toBe(2);
      expect(res.json().counts.published).toBe(1);
      expect(res.json().counts.open).toBe(1);
    });

    it('scopes counts for clients', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/counts',
        headers: authHeader(filterClient.token),
      });
      expect(res.json().counts.all).toBe(2);
    });

    it('exports valuations as CSV within scope', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export',
        headers: authHeader(filterClient.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.body.trim().split('\r\n');
      expect(lines).toHaveLength(3); // header + own 2 valuations only
      expect(res.body).toContain('Zebra Systems');
      expect(res.body).not.toContain('ChatCo');
    });

    it('serves dashboard analytics with kind pivot and source pie', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/stats/dashboard',
        headers: authHeader(filterClient.token),
      });
      expect(res.statusCode).toBe(200);
      const stats = res.json();
      expect(stats.total).toBe(2);
      const kinds = Object.fromEntries(
        stats.by_kind.map((r: { kind: string; total: number }) => [r.kind, r]),
      );
      expect(kinds['409a'].published).toBe(1);
      expect(kinds['esop'].open).toBe(1);
      expect(stats.by_source.direct).toBe(2);

      const ranged = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/stats/dashboard?created_to=2000-01-01',
        headers: authHeader(filterClient.token),
      });
      expect(ranged.json().total).toBe(0);
    });
  });

  // ── Feature 18: clone / roll-forward ───────────────────────────────────────
  describe('clone / roll-forward', () => {
    let sourceId: string;

    beforeAll(async () => {
      sourceId = (await createValuation(client.token, { company_name: 'CloneCo' })).id;
      // give the source some params to copy
      await ctx.pool.query(
        `UPDATE valuation_params SET business_overview = 'B2B SaaS', runway_months = 18
         WHERE valuation_id = $1`,
        [sourceId],
      );
    });

    it('clones with params and links back through the audit spine', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${sourceId}/clone`,
        headers: authHeader(client.token),
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const clone = res.json().valuation;
      expect(clone.id).not.toBe(sourceId);
      expect(clone.state).toBe('pending');
      expect(clone.company_name).toBe('CloneCo');
      expect(clone.paid_status).toBe('unpaid');

      const { rows } = await ctx.pool.query(
        'SELECT business_overview, runway_months, rolling_forward FROM valuation_params WHERE valuation_id = $1',
        [clone.id],
      );
      expect(rows[0]).toMatchObject({
        business_overview: 'B2B SaaS',
        runway_months: 18,
        rolling_forward: false,
      });

      const events = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${clone.id}/events`,
        headers: authHeader(client.token),
      });
      const cloned = events.json().events.find((e: { type: string }) => e.type === 'valuation_cloned');
      expect(cloned.payload.from).toBe(sourceId);
    });

    it('roll-forward marks the copy as rolling forward', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${sourceId}/clone`,
        headers: authHeader(ops.token),
        payload: { roll_forward: true },
      });
      expect(res.statusCode).toBe(201);
      const { rows } = await ctx.pool.query(
        'SELECT rolling_forward FROM valuation_params WHERE valuation_id = $1',
        [res.json().valuation.id],
      );
      expect(rows[0].rolling_forward).toBe(true);
      // ops clone keeps the original owner
      expect(res.json().valuation.user_id).toBe(client.id);
    });

    it('cannot clone a valuation you cannot see', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${sourceId}/clone`,
        headers: authHeader(otherClient.token),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
