import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import QRCode from 'qrcode';
import { problems } from '@n409/shared';
import { requirePrincipal } from '../plugins/auth.js';
import { findUserById } from '../repos/users.js';
import { verifyPassword } from '../auth/password.js';
import { decryptSecret } from '../auth/mfaCrypto.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.js';
import {
  confirmTotpEnrollment,
  countUnusedBackupCodes,
  disableTotp,
  regenerateBackupCodes,
  stageTotpSecret,
} from '../repos/mfa.js';
import type { SystemSettingsStore } from '../repos/systemSettings.js';

/**
 * Self-service TOTP 2FA enrolment for the signed-in user (feature: MFA/2FA).
 * Enrolment is two-phase — /setup stages an encrypted secret and returns the QR,
 * /confirm verifies a live code before enabling it and issuing backup codes —
 * so a half-finished setup never leaves an account unable to sign in.
 *
 * Every route is scoped to the authenticated principal; there is no id in any
 * path. Google-SSO accounts defer their MFA to the IdP and cannot enrol here.
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
      backup_codes_remaining: user.totp_enabled
        ? await countUnusedBackupCodes(deps.pool, user.id)
        : 0,
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
    if (user.totp_enabled)
      throw problems.conflict('2FA is already enabled — disable it first to re-enrol');

    const secret = generateTotpSecret();
    await stageTotpSecret(deps.pool, user.id, secret);
    const uri = otpauthUri(secret, user.email);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
    return { secret, otpauth_uri: uri, qr };
  });

  // Confirm the staged secret with a live code, enable 2FA, and return the
  // one-time backup codes (shown once — only their hashes are persisted).
  app.post('/api/v1/account/mfa/confirm', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    if (user.totp_enabled) throw problems.conflict('2FA is already enabled');
    if (!user.totp_secret)
      throw problems.badRequest('Start setup first — no pending 2FA enrolment');
    if (!verifyTotp(decryptSecret(user.totp_secret), parsed.data.code))
      throw problems.badRequest('That code is incorrect — check your authenticator and try again');

    const backupCodes = await confirmTotpEnrollment(deps.pool, user.id);
    return { enabled: true, backup_codes: backupCodes };
  });

  // Disable 2FA. Re-authenticate with the password so a walk-up on an open
  // session can't strip the second factor.
  app.post('/api/v1/account/mfa/disable', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = PasswordBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

    const user = await findUserById(deps.pool, principal.id);
    if (!user) throw problems.unauthorized();
    if (!user.totp_enabled) return { enabled: false };
    if ((await deps.settings?.get('require_mfa')) ?? false)
      throw problems.forbidden('An administrator requires 2FA — it cannot be disabled');
    if (!user.password_digest || !(await verifyPassword(parsed.data.password, user.password_digest)))
      throw problems.badRequest('Password is incorrect');

    await disableTotp(deps.pool, user.id);
    return { enabled: false };
  });

  // Regenerate backup codes (invalidates the old set). Password-gated.
  app.post(
    '/api/v1/account/mfa/backup-codes',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      const parsed = PasswordBody.safeParse(req.body);
      if (!parsed.success)
        throw problems.unprocessable('Invalid request', { errors: parsed.error.issues });

      const user = await findUserById(deps.pool, principal.id);
      if (!user) throw problems.unauthorized();
      if (!user.totp_enabled) throw problems.badRequest('2FA is not enabled');
      if (!user.password_digest || !(await verifyPassword(parsed.data.password, user.password_digest)))
        throw problems.badRequest('Password is incorrect');

      return { backup_codes: await regenerateBackupCodes(deps.pool, user.id) };
    },
  );
}
