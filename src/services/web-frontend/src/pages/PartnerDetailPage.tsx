import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { displayName, formatDate, formatDateTime, GROUP_LABELS } from '../lib/format';
import type { PartnerDetail } from '../lib/types';
import { Button, ErrorNote, Field, Spinner, StatCard, TextInput } from '../components/ui';

const GROUP_ORDER = ['open', 'in_review', 'drafted', 'published', 'closed'] as const;

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

  const load = useCallback(async () => {
    try {
      const { partner: p } = await api<{ partner: PartnerDetail }>(`/partners/${id}`);
      setPartner(p);
      setBrandColor(p.brand_color ?? '');
      setLogoUrl(p.logo_url ?? '');
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
      <Link
        to="/admin/partners"
        className="text-sm font-semibold text-bond-600 hover:text-bond-700"
      >
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
          <Button
            variant="secondary"
            onClick={() => navigate(`/valuations?partner_id=${partner.id}`)}
          >
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
          <div className="mt-3 overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
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
                            className="rounded border border-ink-200 bg-white px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold text-ink-700"
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

      {/* Branding shown in the partner's portal */}
      <section className="mt-10 rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <h2 className="overline mb-1 text-ink-400">Branding</h2>
        <p className="text-sm text-ink-400">
          Shown to this partner&rsquo;s users in their portal.
        </p>
        <form onSubmit={saveBranding} className="mt-4 flex flex-wrap items-end gap-3">
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
      </section>
    </div>
  );
}
