import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { formatDateTime } from '../lib/format';
import {
  Button,
  ErrorNote,
  Field,
  ListTruncationNote,
  LoadError,
  Spinner,
  SuccessNote,
  TextInput,
  useRetry,
} from '../components/ui';

interface SamlConfig {
  enabled: boolean;
  idp_entity_id: string | null;
  idp_sso_url: string | null;
  idp_cert: string | null;
  sp_entity_id: string | null;
  allowed_domain: string | null;
  default_role: string;
}
interface ScimToken {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const empty: SamlConfig = {
  enabled: false,
  idp_entity_id: '',
  idp_sso_url: '',
  idp_cert: '',
  sp_entity_id: '',
  allowed_domain: '',
  default_role: 'valuation_user',
};

/**
 * Enterprise SSO administration (feature 9): SAML IdP configuration + SCIM
 * bearer-token management. Admin-only.
 */
export function AdminSsoPage() {
  const [config, setConfig] = useState<SamlConfig | null>(null);
  const [tokens, setTokens] = useState<ScimToken[]>([]);
  const [tokensTruncated, setTokensTruncated] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ config: c }, { tokens: t, truncated }] = await Promise.all([
        api<{ config: SamlConfig | null }>('/admin/sso/saml'),
        api<{ tokens: ScimToken[]; truncated: boolean }>('/admin/sso/scim-tokens'),
      ]);
      setConfig(c ? { ...empty, ...c } : empty);
      setTokens(t);
      // A credential that is in force and not on this screen is one nobody
      // will think to revoke.
      setTokensTruncated(truncated);
    } catch {
      setError('Could not load SSO settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, token]);

  if (!config) return error ? <LoadError message={error} {...retryProps} /> : <Spinner />;

  const set = (key: keyof SamlConfig) => (value: string | boolean) =>
    setConfig((c) => (c ? { ...c, [key]: value } : c));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const { config: c } = await api<{ config: SamlConfig }>('/admin/sso/saml', {
        method: 'PUT',
        body: {
          enabled: config.enabled,
          idp_entity_id: config.idp_entity_id || null,
          idp_sso_url: config.idp_sso_url || null,
          idp_cert: config.idp_cert || null,
          sp_entity_id: config.sp_entity_id || null,
          allowed_domain: config.allowed_domain || null,
          default_role: config.default_role,
        },
      });
      setConfig({ ...empty, ...c });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save SAML config.');
    } finally {
      setBusy(false);
    }
  };

  const mintToken = async () => {
    setError(null);
    try {
      const r = await api<{ secret: string }>('/admin/sso/scim-tokens', { method: 'POST', body: {} });
      setMinted(r.secret);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create a SCIM token.');
    }
  };

  // A rejection here used to escape as an unhandled promise, so a revoke the
  // server refused left the token listed as Active with nothing said. A
  // credential believed revoked and still live is the failure this screen
  // exists to prevent.
  const revokeToken = async (id: string) => {
    setError(null);
    try {
      await api(`/admin/sso/scim-tokens/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the SCIM token.');
    }
  };

  return (
    <div className="max-w-2xl">
      <div className="overline flex items-center gap-1.5 text-ink-400">
        Admin
        <HelpIcon article="sso-overview" />
      </div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Enterprise SSO</h1>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <form
        onSubmit={save}
        className="mt-6 space-y-4 rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
      >
        <div className="flex items-center justify-between">
          <h2 className="overline text-ink-400">SAML 2.0 identity provider</h2>
          <label className="flex items-center gap-2 text-sm text-ink-600">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => set('enabled')(e.target.checked)}
            />
            Enabled
          </label>
        </div>
        {saved && <SuccessNote>SAML configuration saved.</SuccessNote>}
        <Field label="IdP SSO URL" hint="SingleSignOnService endpoint (HTTP-Redirect).">
          <TextInput
            value={config.idp_sso_url ?? ''}
            onChange={(e) => set('idp_sso_url')(e.target.value)}
            placeholder="https://idp.example.com/sso"
          />
        </Field>
        <Field label="IdP signing certificate" hint="PEM body (base64), no headers.">
          <textarea
            className="w-full rounded-md border border-paper-300 px-3 py-2 font-mono text-xs"
            rows={5}
            value={config.idp_cert ?? ''}
            onChange={(e) => set('idp_cert')(e.target.value)}
          />
        </Field>
        <Field label="Allowed email domain" hint="Only this domain is JIT-provisioned (optional).">
          <TextInput
            value={config.allowed_domain ?? ''}
            onChange={(e) => set('allowed_domain')(e.target.value)}
            placeholder="corp.com"
          />
        </Field>
        <Field label="SP entity ID (optional)" hint="Defaults to the metadata URL.">
          <TextInput
            value={config.sp_entity_id ?? ''}
            onChange={(e) => set('sp_entity_id')(e.target.value)}
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save SAML config'}
          </Button>
          <a
            href="/api/v1/auth/saml/metadata"
            className="text-sm font-semibold text-bond-600 hover:text-bond-700"
          >
            SP metadata XML
          </a>
        </div>
      </form>

      <section className="mt-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <div className="flex items-center justify-between">
          <h2 className="overline text-ink-400">SCIM provisioning tokens</h2>
          <Button variant="secondary" onClick={mintToken}>
            New token
          </Button>
        </div>
        {minted && (
          <div className="mt-3 rounded-md border border-bond-200 bg-bond-50 p-4">
            <p className="text-sm font-semibold text-bond-800">
              Copy this SCIM token now — it won't be shown again:
            </p>
            <code className="mt-2 block overflow-x-auto overscroll-x-contain rounded bg-surface px-3 py-2 font-mono text-xs text-ink-700">
              {minted}
            </code>
            <p className="mt-2 text-xs text-ink-400">
              SCIM base URL: <code>/scim/v2</code> · Authenticate with{' '}
              <code>Authorization: Bearer &lt;token&gt;</code>
            </p>
          </div>
        )}
        {tokens.length === 0 ? (
          <p className="mt-4 text-sm text-ink-400">No SCIM tokens yet.</p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <caption className="sr-only">SCIM tokens</caption>
            <thead>
              <tr className="sr-only">
                <th scope="col">Label</th>
                <th scope="col">Created</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-b border-paper-200 last:border-0">
                  <td className="px-2 py-2 text-ink-800">{t.label ?? 'SCIM token'}</td>
                  <td className="px-2 py-2 text-ink-500">{formatDateTime(t.created_at)}</td>
                  <td className="px-2 py-2 text-ink-500">{t.revoked_at ? 'Revoked' : 'Active'}</td>
                  <td className="px-2 py-2 text-right">
                    {!t.revoked_at && (
                      <button
                        onClick={() => revokeToken(t.id)}
                        className="text-sm font-semibold text-red-600 hover:text-red-700"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ListTruncationNote truncated={tokensTruncated} shown={tokens.length} noun="SCIM tokens" />
      </section>
    </div>
  );
}
