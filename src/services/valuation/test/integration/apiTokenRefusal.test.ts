import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiToken, revokeApiToken } from '../../src/repos/apiTokens.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What a partner is told when their key stops working.
 *
 * `resolveApiToken` answered `null` to four different conditions and the API
 * said "Invalid or revoked API token" to all four. Three of them have a fix and
 * the fixes are nothing like each other — mint a new key, replace a revoked
 * one, or re-mint under a current member — and the fourth is the one this
 * platform causes itself:
 *
 * A partner token carries the authority its *row* names rather than one re-read
 * from the presenter, so it is scoped to `token.partner_id` and refused if the
 * user who minted it is no longer in that organisation. That refusal is
 * deliberate and documented (moving the org admin who minted a firm's key must
 * not leave their old firm's engagements readable) and it is *reversible* — put
 * the member back and the integration resumes. But reversible is only a useful
 * property if somebody is told it is what happened, and "Invalid or revoked API
 * token" reads exactly like a typo. A firm whose overnight sync went dark got
 * sent to check for a copy-paste error in a key that was fine.
 *
 * These assert on the wire, because that is where a partner reads it. The
 * sentences themselves are pinned in `test/unit/errorMessageQualityR198.ts`.
 */
describe.skipIf(!dbUp)('a refused API token says which refusal it was', () => {
  let ctx: TestApp;
  let partnerId: string;
  let otherPartnerId: string;
  let ownerId: string;

  const call = async (secret: string) =>
    ctx.app.inject({ method: 'GET', url: '/api/partner/v1/valuations', headers: authHeader(secret) });

  beforeAll(async () => {
    ctx = await setupTestApp();
    partnerId = await seedPartner(ctx, `Refusal Firm ${Date.now()}`);
    otherPartnerId = await seedPartner(ctx, `Other Firm ${Date.now()}`);
    const owner = await seedUser(ctx, { roles: ['org_admin'], partnerId });
    ownerId = owner.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('accepts a live token, so the refusals below are about the refusal', async () => {
    // Without this the four cases pass for a suite that cannot authenticate
    // at all — the shape a census in this repo has been caught by before.
    const { secret } = await createApiToken(ctx.pool, {
      partnerId,
      createdBy: ownerId,
      name: 'live',
    });
    expect((await call(secret)).statusCode).toBe(200);
  });

  it('tells a caller with no credential how to send one', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/partner/v1/valuations' });
    expect(res.statusCode).toBe(401);
    const detail = res.json().detail as string;
    // The default was "Authentication required", which states the problem and
    // stops. An integrator needs the scheme and the prefix.
    expect(detail).toContain('Authorization: Bearer');
    expect(detail).toContain('n409_pat_');
  });

  it('does not confirm anything about an unrecognised secret', async () => {
    const res = await call('n409_pat_notarealtokenatall');
    expect(res.statusCode).toBe(401);
    const detail = res.json().detail as string;
    expect(detail).toContain('not recognised');
    // The one case where the presenter proved nothing. It must not imply that
    // some real token was revoked, or that any account exists.
    expect(detail).not.toMatch(/revoked|member/i);
  });

  it('says a revoked token will not work again', async () => {
    const { token, secret } = await createApiToken(ctx.pool, {
      partnerId,
      createdBy: ownerId,
      name: 'to-revoke',
    });
    expect(await revokeApiToken(ctx.pool, token.id)).toBe(true);

    const res = await call(secret);
    expect(res.statusCode).toBe(401);
    const detail = res.json().detail as string;
    expect(detail).toContain('revoked');
    // The distinction that matters: this one is never coming back, so the next
    // step is a replacement rather than a retry.
    expect(detail).toContain('Mint a replacement');
  });

  it('explains the token whose creator left the organization', async () => {
    // The case the platform causes. `resolveApiToken`'s join is what refuses
    // it; before this round the partner could not tell that apart from a typo.
    const leaver = await seedUser(ctx, { roles: ['org_admin'], partnerId });
    const { secret } = await createApiToken(ctx.pool, {
      partnerId,
      createdBy: leaver.id,
      name: 'minted-by-a-leaver',
    });
    expect((await call(secret)).statusCode).toBe(200);

    await ctx.pool.query('UPDATE users SET partner_id = $1 WHERE id = $2', [otherPartnerId, leaver.id]);

    const res = await call(secret);
    expect(res.statusCode).toBe(401);
    const detail = res.json().detail as string;
    expect(detail).toContain('no longer a member');
    expect(detail).toContain('refused rather than revoked');

    // And it really is reversible — which is the claim the sentence makes.
    await ctx.pool.query('UPDATE users SET partner_id = $1 WHERE id = $2', [partnerId, leaver.id]);
    expect((await call(secret)).statusCode).toBe(200);
  });

  it('explains the token whose creator no longer exists', async () => {
    const departing = await seedUser(ctx, { roles: ['org_admin'], partnerId });
    const { secret } = await createApiToken(ctx.pool, {
      partnerId,
      createdBy: departing.id,
      name: 'minted-by-a-deleted-user',
    });
    await ctx.pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [departing.id]);

    const res = await call(secret);
    expect(res.statusCode).toBe(401);
    const detail = res.json().detail as string;
    expect(detail).toContain('no longer exists');
    expect(detail).toContain('under a current user');
  });

  it('refuses a key belonging to a firm the platform has withdrawn', async () => {
    // ARCHIVING A FIRM CLOSED EVERY DOOR A PERSON USES AND NONE OF THE MACHINE
    // ONES (round 342, methodology M3). `partners.archived_at` already stopped
    // new user assignments, branding edits and — the closest analogue —
    // outstanding client intake links, whose own comment calls this flag "the
    // platform's soft delete for a firm". The partner API key was the same
    // authority through the door with nobody behind it to notice, so a
    // withdrawn firm's nightly integration went on reading its old clients'
    // cap tables and creating engagements under it.
    const retiring = await seedPartner(ctx, `Retiring Firm ${Date.now()}`);
    const member = await seedUser(ctx, { roles: ['org_admin'], partnerId: retiring });
    const { secret } = await createApiToken(ctx.pool, {
      partnerId: retiring,
      createdBy: member.id,
      name: 'the-firms-integration',
    });
    expect((await call(secret)).statusCode).toBe(200);

    await ctx.pool.query('UPDATE partners SET archived_at = now() WHERE id = $1', [retiring]);

    const res = await call(secret);
    expect(res.statusCode).toBe(401);
    const detail = res.json().detail as string;
    expect(detail).toContain('has been archived');
    // Distinct from `orphaned` in the one way that changes what to do next:
    // minting another key under a current member produces another refused key.
    expect(detail).toContain('minting a replacement will not help');

    // Refused, not revoked — the claim the sentence makes, and the reason the
    // rule is allowed to be this blunt: un-archiving is one boolean.
    await ctx.pool.query('UPDATE partners SET archived_at = NULL WHERE id = $1', [retiring]);
    expect((await call(secret)).statusCode).toBe(200);
  });

  it('leaves a personal token alone when some other firm is archived', async () => {
    // The clause is `t.partner_id IS NULL OR …`. A personal token belongs to no
    // organisation and must not be caught by an archive anywhere on the
    // platform — the same exemption the membership test beside it carries.
    const personal = await seedUser(ctx, { roles: ['analyst'] });
    const { secret } = await createApiToken(ctx.pool, {
      partnerId: null,
      createdBy: personal.id,
      name: 'personal',
    });
    await ctx.pool.query('UPDATE partners SET archived_at = now() WHERE id = $1', [otherPartnerId]);
    // Personal tokens are refused by the partner API for being personal (403),
    // which is proof they resolved: an unresolved secret is a 401.
    expect((await call(secret)).statusCode).toBe(403);
    await ctx.pool.query('UPDATE partners SET archived_at = NULL WHERE id = $1', [otherPartnerId]);
  });

  it('answers a well-formed but unknown token in one round trip’s worth of words', async () => {
    // The diagnostic SELECT runs only on the miss. Asserted as behaviour rather
    // than by counting queries: a live token must still be one statement, and
    // the case above ('accepts a live token') is what holds that end up.
    const res = await call('n409_pat_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(res.statusCode).toBe(401);
    expect(res.json().title).toBe('Unauthorized');
  });
});
