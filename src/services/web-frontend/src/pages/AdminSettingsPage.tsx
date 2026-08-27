import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { email as emailRule, numberRange, optional, useFormValidation } from '../lib/useFormValidation';
import { formatDateTime } from '../lib/format';
import type { SystemSettings, SystemSettingsResponse } from '../lib/types';
import { Button, ErrorNote, Field, LoadError, Spinner, TextInput, useRetry } from '../components/ui';
import { CapabilityRoster } from '../components/CapabilityRoster';

/**
 * Runtime system configuration. Readable by any ops user, editable only by
 * administrators — the API enforces both, and `editable` in the response tells
 * us which of the two we're rendering for.
 */

interface Knob {
  key: keyof SystemSettings;
  label: string;
  help: string;
}

const TOGGLES: Knob[] = [
  {
    key: 'registration_enabled',
    label: 'Self-service registration',
    help: 'When off, new accounts can only be created by invitation. Existing users sign in as normal.',
  },
  {
    key: 'maintenance_mode',
    label: 'Maintenance mode',
    help: 'Makes the platform read-only for clients and partners. Operations users keep full access, and everyone can still sign in.',
  },
  {
    key: 'require_mfa',
    label: 'Require two-factor authentication',
    help: 'When on, password accounts must enrol in TOTP 2FA and cannot disable it. Google SSO accounts are unaffected.',
  },
];

/**
 * The bounds live on the knob rather than in a ternary at the call site: they
 * are needed twice now — once for the `min`/`max` attributes and once for the
 * rule that actually enforces them — and two copies would drift.
 */
type NumberKey = 'password_min_length' | 'default_delivery_days';

const NUMBERS: Array<Knob & { key: NumberKey; min: number; max: number }> = [
  {
    key: 'password_min_length',
    label: 'Minimum password length',
    help: 'Applies to registration, invitations, resets and password changes. Cannot be set below 10.',
    min: 10,
    max: 128,
  },
  {
    key: 'default_delivery_days',
    label: 'Default delivery days',
    help: 'Pre-filled turnaround on a new valuation.',
    min: 1,
    max: 365,
  },
];

export function AdminSettingsPage() {
  const [data, setData] = useState<SystemSettingsResponse | null>(null);
  const [draft, setDraft] = useState<SystemSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<SystemSettingsResponse>('/admin/settings')
      .then((d) => {
        setData(d);
        setDraft(d.settings);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load system settings.'));
  }, [token]);

  /*
   * Above the early returns — hooks cannot be called conditionally — so the
   * values are read through a fallback for the render before the fetch lands.
   * Nothing is displayed then anyway: no field has been blurred and the form
   * has not been submitted.
   *
   * The form carries `noValidate`, so `min`/`max`/`type="email"` on these
   * controls were decoration. The API enforces the same bounds and answers 422;
   * this is what stops that being the first time anyone hears about it.
   */
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(
    {
      password_min_length: draft?.password_min_length ?? 10,
      default_delivery_days: draft?.default_delivery_days ?? 1,
      support_email: draft?.support_email ?? '',
    },
    {
      password_min_length: numberRange('password_min_length', 10, 128, 'Minimum password length'),
      default_delivery_days: numberRange('default_delivery_days', 1, 365, 'Default delivery days'),
      // Optional: the platform runs without a published support address.
      support_email: optional('support_email', emailRule('support_email', 'Support email')),
    },
  );

  if (error && !data) return <LoadError message={error} {...retryProps} />;
  if (!data || !draft) return <Spinner />;

  const editable = data.editable;
  const dirty = (Object.keys(draft) as Array<keyof SystemSettings>).filter(
    (k) => draft[k] !== data.settings[k],
  );

  /** Only the changed keys are sent, so two admins editing different knobs don't collide. */
  const save = handleSubmit(async () => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const patch = Object.fromEntries(dirty.map((k) => [k, draft[k]]));
      const res = await api<{ settings: SystemSettings }>('/admin/settings', {
        method: 'PUT',
        body: patch,
      });
      setData({ ...data, settings: res.settings });
      setDraft(res.settings);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save system settings.');
    } finally {
      setBusy(false);
    }
  });

  const provenance = (key: keyof SystemSettings) => {
    const meta = data.updated[key];
    if (!meta) return `Default (${String(data.defaults[key])})`;
    return `Changed ${formatDateTime(meta.updated_at)}`;
  };

  return (
    <div className="max-w-2xl">
      <div className="overline text-ink-400">Administration</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">System settings</h1>
      <p className="mt-2 text-sm text-ink-400">
        Platform-wide switches that take effect immediately, without a redeploy. Secrets and service URLs stay
        in the environment. Every change is recorded in the activity log.
      </p>

      {!editable && (
        <p className="mt-4 rounded-md border border-paper-300 bg-paper-100 px-3.5 py-2.5 text-sm text-ink-600">
          You have read-only access — only administrators can change these.
        </p>
      )}

      <form onSubmit={save} className="mt-8 space-y-6" noValidate>
        <ErrorNote>{error}</ErrorNote>
        {saved && (
          <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
            System settings updated.
          </div>
        )}

        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-4 text-ink-400">Access</h2>
          <div className="space-y-5">
            {TOGGLES.map((knob) => (
              <div key={knob.key} className="flex items-start gap-3">
                <input
                  id={knob.key}
                  type="checkbox"
                  className="mt-1 accent-bond-600"
                  disabled={!editable}
                  checked={draft[knob.key] as boolean}
                  onChange={(e) => {
                    setDraft({ ...draft, [knob.key]: e.target.checked });
                    setSaved(false);
                  }}
                />
                <div>
                  <label htmlFor={knob.key} className="text-sm font-semibold text-ink-800">
                    {knob.label}
                  </label>
                  <p className="text-sm text-ink-400">{knob.help}</p>
                  <p className="mt-1 text-xs text-ink-400">{provenance(knob.key)}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-4 text-ink-400">Defaults</h2>
          <div className="space-y-5">
            {NUMBERS.map((knob) => (
              <Field key={knob.key} label={knob.label} hint={knob.help} error={errorFor(knob.key)}>
                <TextInput
                  type="number"
                  className="max-w-[10rem]"
                  disabled={!editable}
                  min={knob.min}
                  max={knob.max}
                  value={String(draft[knob.key])}
                  onChange={(e) => {
                    setDraft({ ...draft, [knob.key]: Number(e.target.value) });
                    setSaved(false);
                  }}
                  onBlur={blurHandler(knob.key)}
                />
              </Field>
            ))}
            <Field
              label="Support email"
              hint="Shown to signed-out visitors on the contact page."
              error={errorFor('support_email')}
            >
              <TextInput
                type="email"
                disabled={!editable}
                value={draft.support_email}
                onChange={(e) => {
                  setDraft({ ...draft, support_email: e.target.value });
                  setSaved(false);
                }}
                onBlur={blurHandler('support_email')}
              />
            </Field>
          </div>
        </section>

        {/* Read-only, and outside the save: these are environment variables, so
            nothing here is a control. It sits under the knobs because the
            sentence above them — "secrets and service URLs stay in the
            environment" — is exactly the reason nobody could see this. */}
        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-1 text-ink-400">Optional integrations</h2>
          <p className="mb-4 text-xs text-ink-400">
            Set in the environment and read at boot. Changing one needs a redeploy.
          </p>
          <CapabilityRoster />
        </section>

        {editable && (
          <div className="flex items-center gap-4">
            <Button type="submit" disabled={busy || dirty.length === 0}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
            {dirty.length > 0 && (
              <button
                type="button"
                className="cursor-pointer text-sm text-ink-400 hover:text-ink-700"
                onClick={() => {
                  setDraft(data.settings);
                  setSaved(false);
                }}
              >
                Discard {dirty.length} change{dirty.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
