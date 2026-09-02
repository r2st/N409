import { useEffect, useState } from 'react';
import { api, describeActionFailure, describeLoadFailure } from '../lib/api';
import { all, pattern, required, useFormValidation } from '../lib/useFormValidation';
import { useAuth } from '../lib/auth';
import { Button, ErrorNote, Field, Spinner, TextInput } from './ui';

interface MfaStatus {
  enabled: boolean;
  confirmed_at: string | null;
  backup_codes_remaining: number;
  required: boolean;
  can_enroll: boolean;
}

interface SetupResponse {
  secret: string;
  otpauth_uri: string;
  qr: string; // data URL
}

/** A one-time-display list of backup codes, downloadable as a text file. */
function BackupCodes({ codes }: { codes: string[] }) {
  const download = () => {
    const blob = new Blob([`N409 two-factor backup codes\n\n${codes.join('\n')}\n`], {
      type: 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'n409-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-800">
        Save these backup codes now — each works once, and they won't be shown again.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-sm text-ink-800" data-testid="backup-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={download}
        className="mt-3 text-sm font-semibold text-bond-600 hover:text-bond-700"
      >
        Download codes
      </button>
    </div>
  );
}

/** Two-factor authentication management (feature: MFA). Enrolment is QR-based
 *  TOTP, confirmed with a live code before it is switched on. */
export function MfaCard() {
  const { user, setUser } = useAuth();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  /*
   * The code and the password live in one object so `useFormValidation` has a
   * values object to read, and are validated by two instances of it: they
   * belong to two forms that are never on screen together, and one shared
   * `submitted` flag would reveal the other form's message.
   */
  const [secrets, setSecrets] = useState({ code: '', password: '' });
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<MfaStatus>('/account/mfa')
      .then(setStatus)
      .catch((err: unknown) => setError(describeLoadFailure(err, 'Could not load two-factor status.')));

  useEffect(() => {
    void load();
  }, []);

  /*
   * Two instances over one values object. The 6-digit shape was expressed as
   * `code.trim().length < 6` on a disabled button, which refused a five-digit
   * code and accepted "abcdef"; the password's rule was the same disabled
   * button with nothing said at all.
   */
  const codeForm = useFormValidation(secrets, {
    code: all(
      required('code', 'Authenticator code'),
      pattern('code', /\d{6}/, 'Enter the six-digit code from your authenticator app.'),
    ),
  });
  const passwordForm = useFormValidation(secrets, {
    password: required('password', 'Password'),
  });

  // A failed status load has to say so. `status` stays null on failure, so the
  // spinner below would otherwise spin for as long as the tab is open while the
  // error it recorded rendered nowhere.
  if (!status) {
    return (
      <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h2 className="overline mb-4 text-ink-400">Two-factor authentication</h2>
        {error ? <ErrorNote>{error}</ErrorNote> : <Spinner />}
      </section>
    );
  }

  /*
   * Password-gated, like the other things on this card (R354).
   *
   * Starting an enrolment is what a stolen session does to finish a takeover:
   * stage its own authenticator, confirm it with a code only it can produce,
   * and the account is protected by the attacker — the owner meets a challenge
   * they cannot answer, and while the organisation requires 2FA the Disable
   * button below is not even offered. The server refuses it without the
   * password now; this is the box to type it into.
   *
   * Through `passwordForm`, the same rule the disable and regenerate buttons
   * use, so an empty box is a message beside the field rather than a round trip.
   */
  const beginSetup = passwordForm.handleSubmit(async () => {
    setError(null);
    setBusy(true);
    try {
      const started = await api<SetupResponse>('/account/mfa/setup', {
        method: 'POST',
        body: { password: secrets.password },
      });
      setSecrets((v) => ({ ...v, password: '' }));
      passwordForm.reset();
      setSetup(started);
    } catch (err) {
      setError(describeActionFailure(err, 'Could not start setup.'));
    } finally {
      setBusy(false);
    }
  });

  const confirm = codeForm.handleSubmit(async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ backup_codes: string[] }>('/account/mfa/confirm', {
        method: 'POST',
        body: { code: secrets.code.trim() },
      });
      setBackupCodes(res.backup_codes);
      setSetup(null);
      setSecrets((v) => ({ ...v, code: '' }));
      codeForm.reset();
      if (user) setUser({ ...user, totp_enabled: true });
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'That code was not accepted.'));
    } finally {
      setBusy(false);
    }
  });

  const disable = passwordForm.handleSubmit(async () => {
    setError(null);
    setBusy(true);
    try {
      await api('/account/mfa/disable', { method: 'POST', body: { password: secrets.password } });
      setSecrets((v) => ({ ...v, password: '' }));
      passwordForm.reset();
      setBackupCodes(null);
      if (user) setUser({ ...user, totp_enabled: false });
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not disable two-factor.'));
    } finally {
      setBusy(false);
    }
  });

  /*
   * Regenerating needs the same password box the disable form does, so it goes
   * through the same rule rather than through its own copy of the check — that
   * copy put "Enter your password to regenerate backup codes." in the card's
   * error banner rather than next to the empty box.
   */
  const regenerate = passwordForm.handleSubmit(async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ backup_codes: string[] }>('/account/mfa/backup-codes', {
        method: 'POST',
        body: { password: secrets.password },
      });
      setBackupCodes(res.backup_codes);
      setSecrets((v) => ({ ...v, password: '' }));
      passwordForm.reset();
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not regenerate backup codes.'));
    } finally {
      setBusy(false);
    }
  });

  return (
    <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="overline text-ink-400">Two-factor authentication</h2>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            status.enabled ? 'bg-bond-50 text-bond-700' : 'bg-paper-100 text-ink-500'
          }`}
          data-testid="mfa-state"
        >
          {status.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <p className="mb-4 text-sm text-ink-400">
        Protect your account with a time-based code from an authenticator app.
        {status.required && ' Your organization requires two-factor authentication.'}
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}
      {backupCodes && (
        <div className="mb-4">
          <BackupCodes codes={backupCodes} />
        </div>
      )}

      {!status.can_enroll ? (
        <p className="text-sm text-ink-500">
          This account signs in with Google SSO; manage two-factor there.
        </p>
      ) : status.enabled ? (
        <div className="space-y-4">
          <p className="text-sm text-ink-600" data-testid="mfa-backup-remaining">
            {status.backup_codes_remaining} backup code
            {status.backup_codes_remaining === 1 ? '' : 's'} remaining.
          </p>
          <Field
            label="Password"
            hint="Required to change these settings."
            error={passwordForm.errorFor('password')}
          >
            <TextInput
              type="password"
              autoComplete="current-password"
              required
              value={secrets.password}
              onChange={(e) => setSecrets((v) => ({ ...v, password: e.target.value }))}
              onBlur={passwordForm.blurHandler('password')}
            />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="secondary" disabled={busy} onClick={regenerate}>
              Regenerate backup codes
            </Button>
            {!status.required && (
              <form onSubmit={disable} noValidate>
                <Button type="submit" variant="danger" disabled={busy}>
                  Disable 2FA
                </Button>
              </form>
            )}
          </div>
        </div>
      ) : setup ? (
        <form onSubmit={confirm} className="space-y-4" noValidate>
          <p className="text-sm text-ink-600">
            Scan this QR code with your authenticator app, then enter the 6-digit code to finish.
          </p>
          <img
            src={setup.qr}
            alt="TOTP QR code"
            width={200}
            height={200}
            className="rounded-md border border-paper-300"
          />
          <p className="text-xs text-ink-400">
            Can't scan? Enter this secret manually:{' '}
            <code className="rounded bg-paper-100 px-1.5 py-0.5 font-mono text-ink-700">{setup.secret}</code>
          </p>
          <Field label="Authenticator code" error={codeForm.errorFor('code')}>
            <TextInput
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={secrets.code}
              onChange={(e) => setSecrets((v) => ({ ...v, code: e.target.value }))}
              onBlur={codeForm.blurHandler('code')}
              placeholder="123456"
            />
          </Field>
          <div className="flex gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? 'Verifying…' : 'Enable 2FA'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setSetup(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <form onSubmit={beginSetup} className="space-y-4" noValidate>
          <Field
            label="Password"
            hint="Confirm it's you before a new authenticator is set up."
            error={passwordForm.errorFor('password')}
          >
            <TextInput
              type="password"
              autoComplete="current-password"
              required
              value={secrets.password}
              onChange={(e) => setSecrets((v) => ({ ...v, password: e.target.value }))}
              onBlur={passwordForm.blurHandler('password')}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? 'Starting…' : 'Set up two-factor authentication'}
          </Button>
        </form>
      )}
    </section>
  );
}
