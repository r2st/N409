import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useBrandingRefresh, type Branding } from '../lib/branding';
import { Button, ErrorNote, Field, Spinner, TextInput } from '../components/ui';

/**
 * White-label branding — a firm shaping its own identity.
 *
 * The stored values are edited here; the *resolved* brand comes back from the
 * API alongside them, which is what the preview renders. That matters because
 * resolution is not a pass-through: a colour that would be illegible on the
 * dark sidebar is corrected server-side, and a firm should see the colour it
 * will actually get rather than the one it typed.
 */

interface BrandingSettings {
  id: string;
  name: string;
  brand_name: string | null;
  brand_tagline: string | null;
  brand_color: string | null;
  accent_color_dark: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  support_email: string | null;
  white_label_enabled: boolean;
}

interface SettingsResponse {
  settings: BrandingSettings;
  /** The brand as it would resolve with the switch on — drives the preview. */
  preview: Branding;
  defaults: Branding;
}

type TextKey = Exclude<keyof BrandingSettings, 'id' | 'name' | 'white_label_enabled'>;

const TEXT_FIELDS: { key: TextKey; label: string; help: string; type?: string }[] = [
  {
    key: 'brand_name',
    label: 'Firm name',
    help: 'Shown in the sidebar, the browser tab and on report covers. Defaults to your channel name.',
  },
  {
    key: 'brand_tagline',
    label: 'Tagline',
    help: 'Small print beside the name, e.g. “409A & ASC 718”. Leave empty for none.',
  },
  {
    key: 'logo_url',
    label: 'Logo URL',
    help: 'HTTPS URL to an SVG or PNG. Used on light backgrounds; replaces the default mark.',
  },
  {
    key: 'logo_dark_url',
    label: 'Logo URL (dark backgrounds)',
    help: 'Optional. Used on the dark sidebar and sign-in panel. Falls back to your main logo.',
  },
  { key: 'favicon_url', label: 'Favicon URL', help: 'Optional. Replaces the browser tab icon.' },
  {
    key: 'support_email',
    label: 'Support email',
    help: 'Shown to your clients as the address to contact for help.',
  },
];

const COLOR_FIELDS: { key: 'brand_color' | 'accent_color_dark'; label: string; help: string }[] = [
  {
    key: 'brand_color',
    label: 'Accent colour',
    help: 'Buttons, links and highlights. Darkened automatically if it would be unreadable on white.',
  },
  {
    key: 'accent_color_dark',
    label: 'Accent colour (dark mode)',
    help: 'Optional. Lightened automatically if it would disappear against the dark sidebar.',
  },
];

export function BrandingPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<BrandingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const refreshBranding = useBrandingRefresh();

  useEffect(() => {
    api<SettingsResponse>('/branding/settings')
      .then((res) => {
        setData(res);
        setDraft(res.settings);
      })
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Only firm administrators can change branding.'
            : err instanceof ApiError && err.status === 404
              ? 'Your account is not attached to a firm, so there is nothing to brand.'
              : 'Could not load branding.',
        ),
      );
  }, []);

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data || !draft) return <Spinner />;

  const dirty = (Object.keys(draft) as Array<keyof BrandingSettings>).filter(
    (k) => draft[k] !== data.settings[k],
  );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      // Empty text inputs mean "unset", which the API models as null — sending
      // '' would store a blank name and defeat the fallback chain.
      const patch = Object.fromEntries(dirty.map((k) => [k, draft[k] === '' ? null : draft[k]]));
      await api<{ settings: BrandingSettings }>('/branding', { method: 'PATCH', body: patch });
      // Re-read rather than merge the PATCH response: `preview` is a resolved
      // brand, so the corrected colours only come back from this endpoint.
      const fresh = await api<SettingsResponse>('/branding/settings');
      setData(fresh);
      setDraft(fresh.settings);
      setSaved(true);
      // Repaint the app in the firm's colours straight away.
      await refreshBranding().catch(() => {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save branding.');
    } finally {
      setBusy(false);
    }
  };

  const set = (key: keyof BrandingSettings, value: string | boolean | null) => {
    setDraft({ ...draft, [key]: value });
    setSaved(false);
  };

  const preview = data.preview;

  return (
    <div className="max-w-3xl">
      <div className="overline text-ink-400">Firm settings</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Branding</h1>
      <p className="mt-2 text-sm text-ink-400">
        Put your firm’s identity in front of your clients. Changes apply across the application, the client
        portal and your report covers. Every change is recorded in the activity log.
      </p>

      <form onSubmit={save} className="mt-8 space-y-6" noValidate>
        <ErrorNote>{error}</ErrorNote>
        {saved && (
          <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
            Branding updated.
          </div>
        )}

        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-4 text-ink-400">Live</h2>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 accent-bond-600"
              checked={draft.white_label_enabled}
              onChange={(e) => set('white_label_enabled', e.target.checked)}
            />
            <span>
              <span className="block text-sm font-medium text-ink-900">Use our branding</span>
              <span className="mt-0.5 block text-sm text-ink-400">
                While this is off you can set everything up privately — your users keep seeing the default
                branding until you turn it on, and turning it off again reverts them.
              </span>
            </span>
          </label>
        </section>

        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-4 text-ink-400">Preview</h2>
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex items-center gap-3 rounded-md bg-chrome-900 px-4 py-3">
              {preview.logo_dark_url ? (
                <img src={preview.logo_dark_url} alt="" className="h-7 object-contain" />
              ) : null}
              <span className="font-display text-lg font-semibold text-chrome-fg">{preview.name}</span>
              {preview.tagline && (
                <span className="overline text-[0.62rem] text-brass-400">{preview.tagline}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {(
                [
                  ['Accent', preview.accent, preview.accent_fg],
                  ['Dark mode', preview.accent_dark, preview.accent_dark_fg],
                ] as const
              ).map(([label, bg, fg]) => (
                <span
                  key={label}
                  className="rounded-md px-3 py-2 text-xs font-semibold"
                  style={{ backgroundColor: bg, color: fg }}
                >
                  {label} {bg}
                </span>
              ))}
            </div>
          </div>
          <p className="mt-3 text-xs text-ink-400">
            Colours shown are the resolved values — adjusted where needed to stay readable.
          </p>
        </section>

        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-4 text-ink-400">Identity</h2>
          <div className="space-y-5">
            {TEXT_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={field.help}>
                <TextInput
                  type={field.key === 'support_email' ? 'email' : 'text'}
                  value={draft[field.key] ?? ''}
                  placeholder={field.key === 'brand_name' ? data.settings.name : undefined}
                  onChange={(e) => set(field.key, e.target.value)}
                />
              </Field>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <h2 className="overline mb-4 text-ink-400">Colour</h2>
          <div className="space-y-5">
            {/* Two controls for one value, so this cannot be a `Field` — that
                wraps a single control in a <label>, and a label owning two
                inputs is ambiguous to a screen reader. */}
            {COLOR_FIELDS.map((field) => (
              <div key={field.key}>
                <label
                  htmlFor={`${field.key}-hex`}
                  className="mb-1.5 block text-[0.8rem] font-semibold text-ink-700"
                >
                  {field.label}
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    aria-label={`${field.label} colour picker`}
                    className="h-9 w-14 cursor-pointer rounded border border-paper-300 bg-surface"
                    value={draft[field.key] ?? data.defaults.accent}
                    onChange={(e) => set(field.key, e.target.value)}
                  />
                  <TextInput
                    id={`${field.key}-hex`}
                    value={draft[field.key] ?? ''}
                    placeholder="#000000"
                    onChange={(e) => set(field.key, e.target.value)}
                  />
                  {draft[field.key] && (
                    <Button type="button" variant="ghost" onClick={() => set(field.key, null)}>
                      Clear
                    </Button>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink-400">{field.help}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || dirty.length === 0}>
            {busy ? 'Saving…' : 'Save branding'}
          </Button>
          {dirty.length > 0 && (
            <span className="text-sm text-ink-400">
              {dirty.length} unsaved change{dirty.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
