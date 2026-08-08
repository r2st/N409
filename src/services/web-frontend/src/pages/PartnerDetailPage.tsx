import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { displayName, formatDate, formatDateTime, GROUP_LABELS } from '../lib/format';
import { PARTNER_EMAIL_TEMPLATE_KEYS } from '../lib/types';
import type { PartnerDetail, ValuationKind, ValuationState } from '../lib/types';
import {
  Button,
  ErrorNote,
  Field,
  KindBadge,
  Pagination,
  Spinner,
  StateBadge,
  StatCard,
  TextInput,
  pageCountOf,
} from '../components/ui';

const GROUP_ORDER = ['open', 'in_review', 'drafted', 'published', 'closed'] as const;

const TEMPLATE_LABELS: Record<string, string> = {
  valuation_started: 'Valuation started',
  review_needed: 'Review needed (reviewer)',
  draft_ready: 'Draft ready',
  valuation_completed: 'Valuation completed',
  valuation_cancelled: 'Valuation cancelled',
};

/**
 * Live white-label preview (improvement 8): a miniature of the branded login
 * card at /partner/:key/login, driven by the UNSAVED form values so admins
 * see the effect before committing.
 */
function BrandingPreview({
  name,
  brandColor,
  logoUrl,
}: {
  name: string;
  brandColor: string;
  logoUrl: string;
}) {
  const accent = /^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : '#1d4ed8';
  return (
    <div data-testid="branding-preview" className="w-full max-w-xs">
      <div className="rounded-lg border border-paper-300 bg-paper-50 p-4 shadow-card">
        <div aria-hidden className="-mx-4 -mt-4 mb-4 h-1 rounded-t-lg" style={{ backgroundColor: accent }} />
        <div className="flex flex-col items-center text-center">
          {logoUrl && (
            <img
              src={logoUrl}
              alt={`${name} logo preview`}
              className="mb-2 max-h-8 max-w-[120px] object-contain"
            />
          )}
          <div className="font-display text-sm font-semibold text-ink-900">{name}</div>
          <div className="mt-0.5 text-[0.65rem] text-ink-400">Sign in to the {name} valuations portal.</div>
          <div className="mt-3 w-full space-y-1.5">
            <div className="h-6 rounded border border-paper-300 bg-surface" />
            <div className="h-6 rounded border border-paper-300 bg-surface" />
            <div
              className="flex h-6 items-center justify-center rounded text-[0.65rem] font-semibold text-white"
              style={{ backgroundColor: accent }}
            >
              Sign in
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ApiToken {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Partner API credentials. The secret is returned exactly once, at creation —
 * it is stored as a hash and nothing can retrieve it afterwards, so it is
 * held in component state and shown until the admin dismisses it rather than
 * flashed in a toast that a mistimed blink loses.
 */
function ApiTokenPanel({ partnerId }: { partnerId: string }) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ name: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { tokens: rows } = await api<{ tokens: ApiToken[] }>(`/partners/${partnerId}/tokens`);
      setTokens(rows);
    } catch {
      setError('Could not load API tokens.');
    }
  }, [partnerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ secret: string }>(`/partners/${partnerId}/tokens`, {
        method: 'POST',
        body: { name: name.trim() },
      });
      setIssued({ name: name.trim(), secret: res.secret });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the token.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: ApiToken) => {
    if (!window.confirm(`Revoke "${token.name}"? Any integration using it stops working immediately.`))
      return;
    setBusy(true);
    try {
      await api(`/api-tokens/${token.id}`, { method: 'DELETE' });
      await load();
    } catch {
      setError('Could not revoke the token.');
    } finally {
      setBusy(false);
    }
  };

  const live = (tokens ?? []).filter((t) => !t.revoked_at);

  return (
    <section className="mt-10 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h2 className="overline mb-1 text-ink-400">API tokens</h2>
      <p className="text-sm text-ink-400">
        Credentials for this partner&rsquo;s server-to-server integration. A token acts for the whole firm, so
        revoking one is the only way to cut off an integration that has gone wrong.
      </p>

      {issued && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-sm font-semibold text-amber-900">
            Copy the secret for &ldquo;{issued.name}&rdquo; now
          </div>
          <p className="mt-0.5 text-xs text-amber-800">
            It is stored as a hash. This is the only time it can be read.
          </p>
          <code className="mt-2 block overflow-x-auto rounded border border-amber-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900">
            {issued.secret}
          </code>
          <button
            onClick={() => setIssued(null)}
            className="mt-2 cursor-pointer text-xs font-semibold text-amber-900 underline"
          >
            I have copied it
          </button>
        </div>
      )}

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <form onSubmit={(e) => void create(e)} className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="New token name" hint="Names the integration, not the person.">
          <TextInput
            aria-label="New token name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Portfolio sync"
            required
            className="!w-72"
          />
        </Field>
        <Button type="submit" disabled={busy || name.trim() === ''}>
          Issue token
        </Button>
      </form>

      {live.length === 0 ? (
        <p className="mt-4 text-sm text-ink-400">No active tokens.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm" aria-label="API tokens">
            <thead>
              <tr className="border-b border-paper-300 text-left text-xs text-ink-400 uppercase">
                <th className="py-1.5 pr-3">Name</th>
                <th className="py-1.5 pr-3">Prefix</th>
                <th className="py-1.5 pr-3">Created</th>
                <th className="py-1.5 pr-3">Last used</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {live.map((t) => (
                <tr key={t.id} className="border-b border-paper-200 last:border-0">
                  <td className="py-2 pr-3 font-semibold text-ink-800">{t.name}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-ink-500">{t.token_prefix}…</td>
                  <td className="py-2 pr-3 text-ink-500">{formatDate(t.created_at)}</td>
                  {/* Never used is worth showing as such: it usually means the
                    integration was never wired up, not that it is idle. */}
                  <td className="py-2 pr-3 text-ink-500">
                    {t.last_used_at ? formatDateTime(t.last_used_at) : 'Never'}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => void revoke(t)}
                      disabled={busy}
                      className="cursor-pointer text-xs font-semibold text-red-600 hover:text-red-700"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface PartnerValuation {
  id: string;
  number: string;
  company_name: string;
  kind: ValuationKind;
  state: ValuationState;
  created_at: string;
}

/**
 * The firm's engagements, as the firm sees them. Ops belong to no firm, so
 * this is scoped by the partner named in the URL rather than by the caller's
 * own scope — which is the point of opening the page.
 */
function PartnerValuations({ partnerId }: { partnerId: string }) {
  const [rows, setRows] = useState<PartnerValuation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ valuations: PartnerValuation[]; total: number }>(
      `/partners/${partnerId}/valuations?page=${page}&per_page=10`,
    )
      .then((d) => {
        setRows(d.valuations);
        setTotal(d.total);
      })
      .catch(() => setError('Could not load this partner’s engagements.'));
  }, [partnerId, page]);

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between">
        <h2 className="overline text-ink-400">Engagements</h2>
        <Link
          to={`/valuations?partner_id=${partnerId}`}
          className="text-sm font-semibold text-bond-600 hover:text-bond-700"
        >
          Open in the valuations list →
        </Link>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {!rows ? (
        <div className="mt-3">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-400">No engagements yet.</p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[620px] text-sm" aria-label="Partner engagements">
              <tbody>
                {rows.map((v) => (
                  <tr key={v.id} className="border-b border-paper-200 last:border-0">
                    <td className="px-5 py-3">
                      <Link
                        to={`/valuations/${v.id}`}
                        className="font-semibold text-ink-900 hover:text-bond-700"
                      >
                        {v.company_name}
                      </Link>
                      <div className="tnum text-xs text-ink-400">#{v.number}</div>
                    </td>
                    <td className="px-4 py-3">
                      <KindBadge kind={v.kind} />
                    </td>
                    <td className="px-4 py-3">
                      <StateBadge state={v.state} />
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-ink-400">{formatDate(v.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageCount={pageCountOf(total, 10)} onPage={setPage} className="mt-4" />
        </>
      )}
    </section>
  );
}

/** P1 #7 — one partner organisation: rollups, users, branding, archive. */
export function PartnerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [partner, setPartner] = useState<PartnerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brandColor, setBrandColor] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [templates, setTemplates] = useState<Record<string, { subject: string; body: string }>>({});
  const [subdomain, setSubdomain] = useState('');
  const [ccEmails, setCcEmails] = useState('');

  const load = useCallback(async () => {
    try {
      const { partner: p } = await api<{ partner: PartnerDetail }>(`/partners/${id}`);
      setPartner(p);
      setBrandColor(p.brand_color ?? '');
      setLogoUrl(p.logo_url ?? '');
      setTemplates(p.email_templates ?? {});
      setSubdomain(p.subdomain ?? '');
      // One address per line: a comma-separated field invites a trailing
      // comma, and a trailing comma is an empty address the API rejects.
      setCcEmails((p.cc_emails ?? []).join('\n'));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'This partner does not exist.'
          : 'Could not load the partner.',
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!partner) return <Spinner />;

  const patch = async (body: Record<string, unknown>, failure: string) => {
    setBusy(true);
    setSaveError(null);
    try {
      await api(`/partners/${partner.id}`, { method: 'PATCH', body });
      await load();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : failure);
    } finally {
      setBusy(false);
    }
  };

  const saveBranding = (e: FormEvent) => {
    e.preventDefault();
    void patch(
      { brand_color: brandColor.trim() || null, logo_url: logoUrl.trim() || null },
      'Could not save the branding.',
    );
  };

  const saveTerms = (e: FormEvent) => {
    e.preventDefault();
    void patch(
      {
        subdomain: subdomain.trim() || null,
        cc_emails: ccEmails
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
      },
      'Could not save the commercial terms.',
    );
  };

  const removeUser = async (user: PartnerDetail['users'][number]) => {
    const partnerRoles = user.roles.filter((r) => r === 'partner' || r === 'member');
    const keptRoles = user.roles.filter((r) => r !== 'partner' && r !== 'member');
    const message =
      partnerRoles.length > 0
        ? `Remove ${user.email} from ${partner.name}? Their ${partnerRoles.join(' and ')} role${
            partnerRoles.length > 1 ? 's are' : ' is'
          } removed too${keptRoles.length === 0 ? ' — they become a regular client user' : ''}.`
        : `Remove ${user.email} from ${partner.name}?`;
    if (!window.confirm(message)) return;
    setBusy(true);
    setSaveError(null);
    try {
      await api(`/users/${user.id}`, {
        method: 'PATCH',
        body: {
          partner_id: null,
          ...(partnerRoles.length > 0
            ? { roles: keptRoles.length > 0 ? keptRoles : ['valuation_user'] }
            : {}),
        },
      });
      await load();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not remove the user.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Link to="/admin/partners" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
        ← All partners
      </Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="overline text-ink-400">Partner</div>
          <h1 className="mt-1 flex items-center gap-3 font-display text-3xl font-semibold text-ink-900">
            {partner.logo_url && (
              <img src={partner.logo_url} alt="" className="h-9 w-9 rounded object-contain" />
            )}
            {partner.name}
            {partner.archived_at && (
              <span className="rounded-full bg-paper-200 px-2.5 py-1 text-xs font-semibold text-ink-400 ring-1 ring-inset ring-ink-200">
                Archived
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-ink-400">
            <span className="font-mono text-xs">{partner.key}</span> · created{' '}
            {formatDate(partner.created_at)}
            {partner.last_activity_at && ` · last activity ${formatDateTime(partner.last_activity_at)}`}
          </p>
        </div>
        <div className="flex gap-2">
          {/* Ops belong to no firm, so the console needs the tenant named in
              the URL — this is the only place that name is known. */}
          <Button variant="secondary" onClick={() => navigate(`/firm?partner_id=${partner.id}`)}>
            Firm console
          </Button>
          <Button variant="secondary" onClick={() => navigate(`/valuations?partner_id=${partner.id}`)}>
            View valuations
          </Button>
          {partner.archived_at ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void patch({ archived: false }, 'Could not restore the partner.')}
            >
              Restore
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Archive ${partner.name}? It disappears from pickers and filters; existing users and valuations keep working.`,
                  )
                )
                  void patch({ archived: true }, 'Could not archive the partner.');
              }}
            >
              Archive
            </Button>
          )}
        </div>
      </div>

      {saveError && (
        <div className="mt-4">
          <ErrorNote>{saveError}</ErrorNote>
        </div>
      )}

      {/* Valuation rollups by state group */}
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Users" value={partner.user_count} />
        {GROUP_ORDER.map((g) => (
          <StatCard
            key={g}
            label={GROUP_LABELS[g] ?? g}
            value={partner.valuations_by_group[g] ?? 0}
            accent={g === 'published'}
          />
        ))}
      </div>

      {/* Users in this organisation */}
      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="overline text-ink-400">Users</h2>
          <Link
            to={`/admin/users?partner=${partner.id}`}
            className="text-sm font-semibold text-bond-600 hover:text-bond-700"
          >
            Manage in users console →
          </Link>
        </div>
        {partner.users.length === 0 ? (
          <p className="mt-3 text-sm text-ink-400">
            No users yet — invite one from the users console with this partner selected.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[560px] text-sm" aria-label="Partner users">
              <tbody>
                {partner.users.map((u) => (
                  <tr key={u.id} className="border-b border-paper-200 last:border-0">
                    <td className="px-5 py-3">
                      <div className="font-semibold text-ink-900">{displayName(u)}</div>
                      <div className="text-xs text-ink-400">{u.email}</div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {u.roles.map((r) => (
                          <span
                            key={r}
                            className="rounded border border-ink-200 bg-surface px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold text-ink-700"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => void removeUser(u)}
                        disabled={busy}
                        className="cursor-pointer text-xs font-semibold text-red-600 hover:text-red-700"
                      >
                        Remove from partner
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Address + commercial terms (0106, 0113) */}
      <section className="mt-10 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h2 className="overline mb-1 text-ink-400">Address &amp; commercial terms</h2>
        <p className="text-sm text-ink-400">
          The address this firm gives its clients, and the two facts about the relationship the platform needs
          to behave correctly.
        </p>
        <form onSubmit={saveTerms} className="mt-4 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="Subdomain"
              hint="3–63 characters of a–z, 0–9 and hyphens. Blank keeps them on the platform's own address."
            >
              <TextInput
                aria-label="Subdomain"
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                placeholder="acme"
                className="!w-56"
              />
            </Field>
            {partner.subdomain && (
              <p className="pb-2 font-mono text-xs text-ink-500">
                {partner.subdomain}
                <span className="text-ink-400">.app.n409.local</span>
              </p>
            )}
          </div>

          <Field
            label="CC addresses"
            hint="One per line. Copied on this firm's client correspondence — usually a shared mailbox."
          >
            <textarea
              aria-label="CC addresses"
              value={ccEmails}
              onChange={(e) => setCcEmails(e.target.value)}
              rows={3}
              placeholder="filings@yourfirm.com"
              className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900 placeholder:text-ink-300 focus:border-bond-500 focus:ring-2 focus:ring-bond-100 focus:outline-none"
            />
          </Field>

          <Button type="submit" disabled={busy}>
            Save terms
          </Button>
        </form>

        {/* Saved on its own rather than with the form: prepaid changes what a
            client is shown at checkout, and a toggle that only takes effect
            when you remember to press Save is how that goes wrong. */}
        <label className="mt-5 flex items-start gap-3 border-t border-paper-200 pt-5 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={partner.prepaid}
            disabled={busy}
            onChange={(e) => void patch({ prepaid: e.target.checked }, 'Could not change the terms.')}
            className="mt-0.5 cursor-pointer"
          />
          <span>
            <strong>Prepaid</strong> — this firm has already paid for its engagements in bulk. Their clients
            are never shown a payment link.
          </span>
        </label>
      </section>

      <ApiTokenPanel partnerId={partner.id} />

      <PartnerValuations partnerId={partner.id} />

      {/* White-label branding: portal, login page, and report PDFs (improvement 8) */}
      <section className="mt-10 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h2 className="overline mb-1 text-ink-400">White-label branding</h2>
        <p className="text-sm text-ink-400">
          Used on this partner&rsquo;s portal, their branded login page, and the cover of their report PDFs.
        </p>
        <p className="mt-2 text-sm text-ink-600">
          Branded login page:{' '}
          <Link
            to={`/partner/${partner.key}/login`}
            className="font-mono text-xs font-semibold text-bond-600 hover:text-bond-700"
          >
            /partner/{partner.key}/login
          </Link>
        </p>
        <div className="mt-4 flex flex-wrap items-start gap-8">
          <form onSubmit={saveBranding} className="flex flex-wrap items-end gap-3">
            <Field label="Brand colour" hint="Hex, e.g. #1f6f54.">
              <TextInput
                aria-label="Brand colour"
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                placeholder="#1f6f54"
                pattern="#[0-9a-fA-F]{6}"
                className="!w-32"
              />
            </Field>
            <Field label="Logo URL">
              <TextInput
                aria-label="Logo URL"
                type="url"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://…/logo.png"
                className="!w-80"
              />
            </Field>
            <Button type="submit" disabled={busy}>
              Save branding
            </Button>
          </form>
          <BrandingPreview name={partner.name} brandColor={brandColor} logoUrl={logoUrl} />
        </div>
      </section>

      {/* Per-partner workflow email templates (improvement 8) */}
      <section className="mt-10 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h2 className="overline mb-1 text-ink-400">Email templates</h2>
        <p className="text-sm text-ink-400">
          Override the workflow emails sent for this partner&rsquo;s engagements. Leave a template blank to
          use the platform default. Placeholders:{' '}
          <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">{'{{company_name}}'}</code>{' '}
          <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">{'{{kind}}'}</code>{' '}
          <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">{'{{partner_name}}'}</code>
        </p>
        <form
          className="mt-5 space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            // Only complete overrides are sent; half-filled rows are dropped.
            const filled = Object.fromEntries(
              Object.entries(templates).filter(([, t]) => t.subject.trim() !== '' && t.body.trim() !== ''),
            );
            void patch({ email_templates: filled }, 'Could not save the email templates.');
          }}
        >
          {PARTNER_EMAIL_TEMPLATE_KEYS.map((key) => {
            const t = templates[key] ?? { subject: '', body: '' };
            const set = (field: 'subject' | 'body', value: string) =>
              setTemplates((prev) => ({ ...prev, [key]: { ...t, [field]: value } }));
            return (
              <div key={key} className="border-b border-paper-200 pb-5 last:border-0 last:pb-0">
                <div className="mb-2 text-sm font-semibold text-ink-800">
                  {TEMPLATE_LABELS[key] ?? key}
                  {t.subject && t.body && (
                    <span className="ml-2 rounded-full bg-bond-50 px-2 py-0.5 text-xs font-semibold text-bond-700">
                      Customized
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  <TextInput
                    aria-label={`${TEMPLATE_LABELS[key] ?? key} subject`}
                    placeholder="Subject (platform default)"
                    value={t.subject}
                    onChange={(e) => set('subject', e.target.value)}
                  />
                  <textarea
                    aria-label={`${TEMPLATE_LABELS[key] ?? key} body`}
                    placeholder="Body (platform default)"
                    value={t.body}
                    onChange={(e) => set('body', e.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus:border-bond-500 focus:ring-2 focus:ring-bond-100 focus:outline-none"
                  />
                </div>
              </div>
            );
          })}
          <Button type="submit" disabled={busy}>
            Save email templates
          </Button>
        </form>
      </section>
    </div>
  );
}
