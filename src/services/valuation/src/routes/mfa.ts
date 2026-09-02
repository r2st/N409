import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import QRCode from 'qrcode';
import { problems } from '@n409/shared';
import { requirePrincipal } from '../plugins/auth.js';
import { findUserById } from '../repos/users.js';
import { verifyReauthPassword } from '../auth/reauth.js';
import { decryptSecret } from '../auth/mfaCrypto.js';
import { generateTotpSecret, otpauthUri, verifyTotpCounter } from '../auth/totp.js';
import {
  confirmTotpEnrollment,
  consumeTotpCounter,
  countUnusedBackupCodes,
  disableTotp,
  regenerateBackupCodes,
  stageTotpSecret,
} from '../repos/mfa.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import type { SystemSettingsStore } from '../repos/systemSettings.js';
import { invalidBody } from '../domain/validationProblem.js';

/**
 * Self-service TOTP 2FA enrolment for the signed-in user (feature: MFA/2FA).
 * Enrolment is two-phase — /setup stages an encrypted secret and returns the QR,
 * /confirm verifies a live code before enabling it and issuing backup codes —
 * so a half-finished setup never leaves an account unable to sign in.
 *
 * Every route is scoped to the authenticated principal; there is no id in any
 * path. Google-SSO accounts defer their MFA to the IdP and cannot enrol here.
 *
 * ## The audit record
 *
 * This file wrote none until R159. Enrolling a second factor, *removing* one,
 * and replacing the backup-code set are three of the small number of actions
 * that decide whether an account can be taken over, and none of them left a
 * row — while an administrator changing somebody's role, resending an
 * invitation or editing a prompt all did. A takeover that got as far as a
 * session would strip the second factor and leave the trail saying nothing had
 * happened.
 *
 * `/setup` deliberately writes no event. It stages a candidate secret that is
 * inert until `/confirm` verifies a live code against it, is overwritten by the
 * next `/setup`, and grants nothing on its own; recording it would put a row
 * against every abandoned QR screen and dilute the three that mean something.
 * `/confirm` is the moment the factor exists.
 */

const ConfirmBody = z.object({ code: z.string().min(6).max(10) });
const PasswordBody = z.object({ password: z.string().min(1) });

export function registerMfaRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; settings?: SystemSettingsStore },
): void {
  app.get('/api/v1/account/mfa', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    return {
      enabled: user.totp_enabled,
      confirmed_at: user.totp_confirmed_at,
      backup_codes_remaining: user.totp_enabled ? await countUnusedBackupCodes(deps.pool, user.id) : 0,
      required: (await deps.settings?.get('require_mfa')) ?? false,
      can_enroll: Boolean(user.password_digest), // SSO-only accounts cannot
    };
  });

  // Stage a new secret and return the QR + manual-entry secret. Overwrites any
  // prior un-confirmed staging; harmless because it isn't enabled until /confirm.
  app.post('/api/v1/account/mfa/setup', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    if (!user.password_digest)
      throw problems.badRequest('This account signs in with Google SSO and manages 2FA there');
    if (user.totp_enabled) throw problems.conflict('2FA is already enabled — disable it first to re-enrol');

    const secret = generateTotpSecret();
    // The refusal above again, this time as the write's own predicate. Staging
    // clears `totp_enabled`, so losing this race is not a wasted request — it
    // is the second factor coming off an account that had just switched it on.
    if (!(await stageTotpSecret(deps.pool, user.id, secret)))
      throw problems.conflict('2FA is already enabled — disable it first to re-enrol');
    const uri = otpauthUri(secret, user.email);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
    return { secret, otpauth_uri: uri, qr };
  });

  // Confirm the staged secret with a live code, enable 2FA, and return the
  // one-time backup codes (shown once — only their hashes are persisted).
  app.post('/api/v1/account/mfa/confirm', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);

    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    if (user.totp_enabled) throw problems.conflict('2FA is already enabled');
    if (!user.totp_secret) throw problems.badRequest('Start setup first — no pending 2FA enrolment');
    // Spend the time step here too: the code that finishes enrolment would
    // otherwise still be live at the login prompt a few seconds later.
    const counter = verifyTotpCounter(decryptSecret(user.totp_secret), parsed.data.code);
    if (counter === null || !(await consumeTotpCounter(deps.pool, user.id, counter)))
      throw problems.badRequest('That code is incorrect — check your authenticator and try again');

    const backupCodes = await confirmTotpEnrollment(deps.pool, user.id, user.totp_secret);
    // The two refusals above, asked again as the write's own predicate and
    // answered here when it did not apply. `POST /setup` is repeatable and
    // replaces whatever is staged, so the secret this code was checked against
    // is not necessarily the one still on the row — see
    // `confirmTotpEnrollment`. Restarting is the only honest remedy: the code
    // the caller holds belongs to a QR the account no longer has.
    if (backupCodes === null)
      throw problems.conflict(
        'This enrolment was superseded — the 2FA setup was restarted elsewhere. Open setup again and ' +
          'scan the new QR code.',
      );
    await recordAdminEvent(deps.pool, {
      type: 'user_mfa_enabled',
      actor: { actorType: 'human', actorId: user.id },
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      payload: { method: 'totp', backup_codes_issued: backupCodes.length },
    });
    return { enabled: true, backup_codes: backupCodes };
  });

  // Disable 2FA. Re-authenticate with the password so a walk-up on an open
  // session can't strip the second factor.
  app.post('/api/v1/account/mfa/disable', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = PasswordBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);

    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    if (!user.totp_enabled) return { enabled: false };
    if ((await deps.settings?.get('require_mfa')) ?? false)
      throw problems.forbidden('An administrator requires 2FA — it cannot be disabled');
    if (!(await verifyReauthPassword(user.id, parsed.data.password, user.password_digest)))
      throw problems.badRequest('Password is incorrect');

    await disableTotp(deps.pool, user.id);
    await recordAdminEvent(deps.pool, {
      type: 'user_mfa_disabled',
      actor: { actorType: 'human', actorId: user.id },
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      payload: { method: 'totp' },
    });
    return { enabled: false };
  });

  // Regenerate backup codes (invalidates the old set). Password-gated.
  app.post('/api/v1/account/mfa/backup-codes', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = PasswordBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid request', parsed.error);

    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    if (!user.totp_enabled) throw problems.badRequest('2FA is not enabled');
    if (!(await verifyReauthPassword(user.id, parsed.data.password, user.password_digest)))
      throw problems.badRequest('Password is incorrect');

    const codes = await regenerateBackupCodes(deps.pool, user.id);
    await recordAdminEvent(deps.pool, {
      type: 'user_mfa_backup_codes_regenerated',
      actor: { actorType: 'human', actorId: user.id },
      subjectType: 'user',
      subjectId: user.id,
      subjectLabel: user.email,
      payload: { issued: codes.length },
    });
    return { backup_codes: codes };
  });
}
