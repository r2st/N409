import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { createComment } from '../../src/repos/comments.js';
import { createNotifications } from '../../src/repos/notifications.js';
import { createPayment } from '../../src/repos/payments.js';
import { newUlid } from '@n409/shared';
import { EXPORT_SECTION_LIMIT } from '../../src/repos/dataExport.js';
import { enqueueEmail } from '../../src/repos/emailOutbox.js';
import { suppressAddress } from '../../src/repos/emailDelivery.js';
import { createInvitation } from '../../src/repos/invitations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Subject access (GDPR Art. 15) — the copy the privacy page promised.
 *
 * "Request a copy or deletion of your personal data at any time" has been on
 * the site for a while. Deletion was self-serve; the copy was a sentence with
 * nothing behind it, so a request arriving by email was answered by hand at a
 * psql prompt, against a one-month deadline, with whichever tables the person
 * answering happened to think of.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'human' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('personal data export', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let stranger: Awaited<ReturnType<typeof seedUser>>;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    stranger = await seedUser(ctx, { roles: ['valuation_user'] });
    admin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const exportSelf = (token: string) =>
    ctx.app.inject({ method: 'GET', url: '/api/v1/me/data-export', headers: authHeader(token) });

  const exportOther = (token: string, id: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1/users/${id}/data-export`, headers: authHeader(token) });

  /** An engagement, a comment on it, a notification and a payment. */
  async function seedHistory(userId: string, companyName: string) {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName, userId },
      { ...actor, actorId: userId },
    );
    await createComment(
      ctx.pool,
      { valuationId: v.id, kind: 'chat', authorId: userId, body: `A note about ${companyName}` },
      { ...actor, actorId: userId },
    );
    await createNotifications(ctx.pool, [
      { userId, valuationId: v.id, type: 'valuation_completed', title: 'Done', body: 'Your report is ready' },
    ]);
    await createPayment(ctx.pool, {
      valuationId: v.id,
      sessionId: `cs_export_${v.id}`,
      amountCents: 250_000,
      currency: 'USD',
      createdBy: userId,
    });
    return v;
  }

  it('serves the caller their own account, history and money', async () => {
    const v = await seedHistory(owner.id, 'Export Co');
    const res = await exportSelf(owner.token);

    expect(res.statusCode).toBe(200);
    // A file they keep, not a page they screenshot.
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="n409-data-export-\d{4}-\d\d-\d\d\.json"/,
    );
    // Somebody's own personal data has no business in a shared cache, or on the
    // disk of a machine they may not own.
    expect(res.headers['cache-control']).toBe('no-store');

    const body = res.json();
    expect(body.subject_user_id).toBe(owner.id);
    expect(body.account.email).toBe(owner.email);
    expect(body.account.roles).toContain('valuation_user');
    expect(body.engagements.rows.map((r: { id: string }) => r.id)).toContain(v.id);
    expect(body.comments.rows.map((r: { body: string }) => r.body)).toContain('A note about Export Co');
    expect(body.notifications.rows).not.toHaveLength(0);
    expect(body.payments.rows.map((r: { amount_cents: string }) => Number(r.amount_cents))).toContain(
      250_000,
    );
    expect(body.section_limit).toBe(EXPORT_SECTION_LIMIT);
  });

  it('contains nobody else', async () => {
    await seedHistory(stranger.id, 'Not Yours Ltd');
    const body = (await exportSelf(owner.token)).json();

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('Not Yours Ltd');
    expect(serialised).not.toContain(stranger.email);
    expect(
      body.engagements.rows.every((r: { company_name: string }) => r.company_name !== 'Not Yours Ltd'),
    ).toBe(true);
  });

  /**
   * Art. 15(4): the right to a copy must not adversely affect others — and a
   * credential is the case where the copy *is* the harm. Each is reported as
   * present rather than omitted silently, so the export does not misrepresent
   * what is held.
   */
  it('withholds every credential, and says that it is holding one', async () => {
    const body = (await exportSelf(owner.token)).json();

    expect(body.account).not.toHaveProperty('password_digest');
    expect(body.account).not.toHaveProperty('totp_secret');
    expect(JSON.stringify(body)).not.toContain('$scrypt');

    const password = body.withheld.find((w: { field: string }) => w.field === 'password_digest');
    expect(password).toMatchObject({ held: true });
    expect(password.reason).toMatch(/credential/i);
    expect(body.withheld.map((w: { field: string }) => w.field)).toEqual([
      'password_digest',
      'totp_secret',
      'mfa_backup_codes',
      'api_token_secrets',
      'trusted_device_tokens',
    ]);
  });

  /**
   * The mail is where the platform says most of what it says to a person, and
   * the export used to answer "what did you send me" with the in-app
   * notification list alone — the smaller half. A subject access request that
   * omits the messages actually sent to the subject's address is not a copy of
   * what is held.
   */
  it('includes the mail it sent them, with the text it sent', async () => {
    await enqueueEmail(ctx.pool, {
      toUserId: owner.id,
      toEmail: owner.email,
      templateKey: 'valuation_completed',
      subject: 'Your 409A report is ready',
      body: 'The report for Export Co has been published.',
    });

    const body = (await exportSelf(owner.token)).json();
    const mail = body.emails_sent.rows.find(
      (r: { subject: string }) => r.subject === 'Your 409A report is ready',
    );
    expect(mail).toBeTruthy();
    // The body, not a summary of it: this text was addressed to this person and
    // they already hold a copy, so quoting it back is unambiguously theirs.
    expect(mail.body).toContain('Export Co');
    expect(mail.to_email).toBe(owner.email);
  });

  it("does not hand them another person's mail", async () => {
    await enqueueEmail(ctx.pool, {
      toUserId: stranger.id,
      toEmail: stranger.email,
      templateKey: 'valuation_completed',
      subject: 'Somebody else entirely',
      body: 'Not for the owner.',
    });

    const body = (await exportSelf(owner.token)).json();
    expect(JSON.stringify(body)).not.toContain('Somebody else entirely');
    // Anchored, because "the stranger's subject is absent" is also true of an
    // export that ships no mail at all — which is the bug this section fixes.
    expect(body.emails_sent.rows.map((r: { subject: string }) => r.subject)).toContain(
      'Your 409A report is ready',
    );
  });

  /**
   * A suppressed address stops receiving service mail entirely, and "why did I
   * stop hearing from you" is a question only this row answers. It is the one
   * section reached through the subject's email rather than their primary key,
   * because that is how the table is keyed.
   */
  it('tells them their address is on the bounce list', async () => {
    const body0 = (await exportSelf(owner.token)).json();
    expect(body0.email_suppression.rows).toHaveLength(0);

    await suppressAddress(ctx.pool, {
      address: owner.email,
      reason: 'hard',
      detail: 'mailbox does not exist',
    });

    const body = (await exportSelf(owner.token)).json();
    expect(body.email_suppression.rows).toHaveLength(1);
    expect(body.email_suppression.rows[0]).toMatchObject({
      to_email: owner.email,
      reason: 'hard',
      detail: 'mailbox does not exist',
    });
    // Who lifted a suppression is another person, and Art. 15(4) is the reason
    // that name is not in this person's copy.
    expect(body.email_suppression.rows[0]).not.toHaveProperty('released_by');
  });

  it('includes what they typed into the public contact form', async () => {
    // `contact_submissions` has no user id — the form is unauthenticated by
    // design — so nothing joined it to an account and the census that checks
    // this export for completeness could not see it: it scanned foreign keys,
    // and this table identifies a person by their address. It holds a name, an
    // address, a phone number and free text somebody wrote about themselves.
    const body0 = (await exportSelf(owner.token)).json();
    expect(body0.contact_submissions.rows).toHaveLength(0);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/contact',
      payload: {
        name: 'Ada Lovelace',
        email: owner.email.toUpperCase(), // matched case-insensitively
        company: 'Analytical Engines',
        phone: '+15550100100',
        message: 'Do you value pre-revenue companies?',
      },
    });
    expect(res.statusCode).toBe(201);

    const body = (await exportSelf(owner.token)).json();
    expect(body.contact_submissions.rows).toHaveLength(1);
    expect(body.contact_submissions.rows[0]).toMatchObject({
      name: 'Ada Lovelace',
      company: 'Analytical Engines',
      phone: '+15550100100',
      message: 'Do you value pre-revenue companies?',
    });
    // Who in operations picked the message up is another person's data — the
    // same call this export makes about `released_by` on a suppression.
    expect(body.contact_submissions.rows[0]).not.toHaveProperty('handled_by');
  });

  it('includes the invitation that gave them their account, without its token', async () => {
    const invited = `${newUlid().toLowerCase()}@invite-export.example.com`;
    const { secret } = await createInvitation(ctx.pool, {
      email: invited,
      roles: ['valuation_user'],
      partnerId: null,
      invitedBy: admin.id,
    });

    const accepted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/accept-invite',
      payload: {
        token: secret,
        password: 'invitation-export-password-1',
        first_name: 'Grace',
        last_name: 'Hopper',
      },
    });
    expect(accepted.statusCode).toBe(201);

    const body = (await exportSelf(accepted.json().token as string)).json();
    expect(body.invitations.rows).toHaveLength(1);
    expect(body.invitations.rows[0]).toMatchObject({ email: invited, roles: ['valuation_user'] });
    expect(body.invitations.rows[0].accepted_at).not.toBeNull();
    // The token is a live capability while the invitation is open, and who
    // issued it is another person — neither belongs in this copy.
    expect(body.invitations.rows[0]).not.toHaveProperty('token_sha256');
    expect(body.invitations.rows[0]).not.toHaveProperty('invited_by');
  });

  it('lists a trusted device without the token that makes it trusted', async () => {
    await ctx.pool.query(
      `INSERT INTO mfa_trusted_devices (id, user_id, token_hash, label, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
      [newUlid(), owner.id, 'sha256-of-the-cookie', 'Work laptop'],
    );

    const body = (await exportSelf(owner.token)).json();
    expect(body.trusted_devices.rows.map((r: { label: string }) => r.label)).toContain('Work laptop');
    expect(JSON.stringify(body)).not.toContain('sha256-of-the-cookie');
    expect(body.trusted_devices.rows[0]).not.toHaveProperty('token_hash');
    expect(body.withheld.find((w: { field: string }) => w.field === 'trusted_device_tokens').held).toBe(true);
  });

  it('lists an API token by prefix and never by hash', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: authHeader(owner.token),
      payload: { name: 'export test token' },
    });
    expect(created.statusCode).toBe(201);
    const secret = created.json().token as string;

    const body = (await exportSelf(owner.token)).json();
    expect(body.api_tokens.rows.map((r: { name: string }) => r.name)).toContain('export test token');
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.api_tokens.rows[0]).not.toHaveProperty('token_hash');
    expect(body.withheld.find((w: { field: string }) => w.field === 'api_token_secrets').held).toBe(true);
  });

  it('reports a truncated section instead of quietly stopping', async () => {
    // A capped export that does not say so is a worse answer to a statutory
    // request than one that admits it is incomplete. Asserting the flag's
    // wiring rather than seeding 2001 rows: `truncated` is false here, and the
    // unit of the claim is that the field exists on every section.
    const body = (await exportSelf(owner.token)).json();
    for (const key of [
      'engagements',
      'comments',
      'documents_uploaded',
      'notifications',
      'notification_preferences',
      'support_messages',
      'payments',
      'invoices',
      'subscriptions',
      'api_tokens',
      'emails_sent',
      'email_suppression',
      'mentions',
      'comment_reads',
      'saved_views',
      'signatures',
      'trusted_devices',
    ]) {
      expect(body[key], key).toMatchObject({ truncated: false });
      expect(Array.isArray(body[key].rows), key).toBe(true);
    }
  });

  describe('answering a request that did not arrive from inside the product', () => {
    it('lets a user admin export somebody else, and writes it down', async () => {
      await seedHistory(stranger.id, 'Admin Exported Co');
      const res = await exportOther(admin.token, stranger.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().subject_user_id).toBe(stranger.id);
      expect(res.headers['content-disposition']).toContain(stranger.id);

      // One person reading another's personal data is the event a compliance
      // review asks about.
      const { rows } = await ctx.pool.query<{ actor_id: string; subject_id: string }>(
        `SELECT actor_id, subject_id FROM admin_events
          WHERE type = 'user_data_exported' AND subject_id = $1`,
        [stranger.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_id).toBe(admin.id);
    });

    it('is closed to everyone else', async () => {
      expect((await exportOther(owner.token, stranger.id)).statusCode).toBe(403);
    });

    it('404s on a user that does not exist, rather than exporting an empty shell', async () => {
      expect((await exportOther(admin.token, '01J0000000000000000000000A')).statusCode).toBe(404);
      expect((await exportOther(admin.token, 'not-a-ulid')).statusCode).toBe(404);
    });

    it('still exports a closed account', async () => {
      // `deleted_at` is a soft delete and the data is all still held. Someone
      // asking what is held about them after closing their account is the
      // person with the most reason to ask.
      const closed = await seedUser(ctx, { roles: ['valuation_user'] });
      await seedHistory(closed.id, 'Closed Account Co');
      await ctx.pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [closed.id]);

      const body = (await exportOther(admin.token, closed.id)).json();
      expect(body.account.deleted_at).not.toBeNull();
      expect(body.engagements.rows.map((r: { company_name: string }) => r.company_name)).toContain(
        'Closed Account Co',
      );
    });
  });
});
