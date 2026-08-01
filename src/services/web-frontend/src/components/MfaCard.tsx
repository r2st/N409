import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
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
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<MfaStatus>('/account/mfa')
      .then(setStatus)
      .catch(() => setError('Could not load two-factor status.'));

  useEffect(() => {
    void load();
  }, []);

  if (!status) {
    return (
      <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h2 className="overline mb-4 text-ink-400">Two-factor authentication</h2>
        <Spinner />
      </section>
    );
  }

  const beginSetup = async () => {
    setError(null);
    setBusy(true);
    try {
      setSetup(await api<SetupResponse>('/account/mfa/setup', { method: 'POST' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start setup.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ backup_codes: string[] }>('/account/mfa/confirm', {
        method: 'POST',
        body: { code: code.trim() },
      });
      setBackupCodes(res.backup_codes);
      setSetup(null);
      setCode('');
      if (user) setUser({ ...user, totp_enabled: true });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/account/mfa/disable', { method: 'POST', body: { password } });
      setPassword('');
      setBackupCodes(null);
      if (user) setUser({ ...user, totp_enabled: false });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disable two-factor.');
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!password.trim()) {
      setError('Enter your password to regenerate backup codes.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ backup_codes: string[] }>('/account/mfa/backup-codes', {
        method: 'POST',
        body: { password },
      });
      setBackupCodes(res.backup_codes);
      setPassword('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not regenerate backup codes.');
    } finally {
      setBusy(false);
    }
  };

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
          <Field label="Password" hint="Required to change these settings.">
            <TextInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="secondary" disabled={busy} onClick={regenerate}>
              Regenerate backup codes
            </Button>
            {!status.required && (
              <form onSubmit={disable}>
                <Button type="submit" variant="danger" disabled={busy || !password.trim()}>
                  Disable 2FA
                </Button>
              </form>
            )}
          </div>
        </div>
      ) : setup ? (
        <form onSubmit={confirm} className="space-y-4">
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
          <Field label="Authenticator code">
            <TextInput
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
            />
          </Field>
          <div className="flex gap-3">
            <Button type="submit" disabled={busy || code.trim().length < 6}>
              {busy ? 'Verifying…' : 'Enable 2FA'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setSetup(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" disabled={busy} onClick={beginSetup}>
          {busy ? 'Starting…' : 'Set up two-factor authentication'}
        </Button>
      )}
    </section>
  );
}
