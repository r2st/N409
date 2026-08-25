import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import {
  isEmailAddress,
  optional,
  pattern,
  required,
  useFormValidation,
  type Rules,
} from '../lib/useFormValidation';
import { displayName, formatDate, formatDateTime, GROUP_LABELS } from '../lib/format';
import { NAMED_BUCKETS, PARTNER_EMAIL_TEMPLATE_KEYS } from '../lib/types';
import { useLatestOnly } from '../lib/useLatestOnly';
import type { NamedBucketKey, PartnerDetail, ValuationKind, ValuationState } from '../lib/types';
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

/**
 * The firm's queue, in the nine named buckets (design §4.2 / §4.4).
 *
 * Every tile is a link into `/valuations?partner_id=…&bucket=…` rather than a
 * number on a page: the whole gap this closes is that a partner-scoped listing
 * was reachable only by picking the firm out of a filter dropdown. Buckets
 * rather than state groups because that is what the listing's tab strip and
 * the sidebar badges show — a firm page that counted in a different vocabulary
 * would be a third answer to "how many are in progress".
 *
 * Empty buckets are dropped here, unlike on the listing itself. The listing
 * always shows all nine because the tab strip is a fixed set of controls; this
 * is a summary, and nine tiles of which six read zero buries the two that do
 * not.
 */
function PartnerQueue({ partner }: { partner: PartnerDetail }) {
  const counts = partner.valuations_by_bucket ?? {};
  const tiles = NAMED_BUCKETS.filter(
    (key): key is Exclude<NamedBucketKey, 'all'> => key !== 'all' && (counts[key] ?? 0) > 0,
  );
  const total = counts.all ?? 0;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="overline text-ink-400">Engagement queue</h2>
        <Link
          to={`/valuations?partner_id=${partner.id}`}
          className="text-sm font-semibold text-bond-600 hover:text-bond-700"
        >
          Open the full listing ({total}) →
        </Link>
      </div>
      {tiles.length === 0 ? (
        <p className="mt-3 text-sm text-ink-400">No engagements yet for this firm.</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {tiles.map((key) => (
            <Link
              key={key}
              to={`/valuations?partner_id=${partner.id}&bucket=${key}`}
              className="rounded-full border border-paper-300 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-700 transition-colors hover:border-bond-300 hover:text-bond-700"
            >
              {BUCKET_LABELS[key]} <span className="tnum text-ink-400">{counts[key] ?? 0}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Pin the firm's listing as a shared saved view.
 *
 * Shipped as a saved view and not a second listing page, per the spec: a new
 * page would duplicate the filter, sort, export and scope logic the existing
 * listing's sweep test already covers, and a second listing is a second place
 * for the scope rules to be wrong.
 */
function PinPartnerView({ partnerId, partnerName }: { partnerId: string; partnerName: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'pinned' | 'already'>('idle');
  const [error, setError] = useState<string | null>(null);

  const pin = async () => {
    setState('busy');
    setError(null);
    try {
      const res = await api<{ created: boolean }>(`/partners/${partnerId}/saved-view`, {
        method: 'POST',
      });
      setState(res.created ? 'pinned' : 'already');
    } catch (err) {
      setState('idle');
      setError(err instanceof ApiError ? err.message : 'Could not pin the view.');
    }
  };

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button variant="secondary" disabled={state === 'busy'} onClick={() => void pin()}>
        {state === 'busy' ? 'Pinning…' : 'Pin to saved views'}
      </Button>
      {state === 'pinned' && (
        <span className="text-sm text-bond-700">
          “{partnerName}” is now in the saved views on the valuations list, for the whole ops team.
        </span>
      )}
      {state === 'already' && (
        <span className="text-sm text-ink-500">Already pinned — it is in the saved views strip.</span>
      )}
      {error && (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Bucket labels for the firm summary. The listing itself reads its labels off
 * the wire beside the counts; this page has counts without a catalog, so it
 * restates them — and the keys are typed against `NAMED_BUCKETS`, so a bucket
 * added server-side fails the build here rather than rendering blank.
 */
const BUCKET_LABELS: Record<Exclude<NamedBucketKey, 'all'>, string> = {
  incomplete: 'Incomplete',
  unverified: 'Unverified',
  in_progress: 'In progress',
  waiting_on_client: 'Waiting on client',
  drafted: 'Drafted',
  published: 'Published',
  unread: 'Unread',
  ignored: 'Ignored',
};

interface TemplatePair {
  subject: string;
  body: string;
}

/** Module-scope so an unset template keeps the same identity between renders. */
const EMPTY_TEMPLATE: TemplatePair = { subject: '', body: '' };

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

  // `:id` changes without this page being torn down — one firm's detail links
  // straight to another's — so a late reply lists one partner's live API
  // credentials under a different partner's name. See `useLatestOnly`.
  const claim = useLatestOnly();

  const load = useCallback(async () => {
    const current = claim();
    try {
      const { tokens: rows } = await api<{ tokens: ApiToken[] }>(`/partners/${partnerId}/tokens`);
      if (current()) setTokens(rows);
    } catch {
      if (current()) setError('Could not load API tokens.');
    }
  }, [partnerId, claim]);

  useEffect(() => {
    void load();
  }, [load]);

  const { errorFor, blurHandler, handleSubmit, reset } = useFormValidation(
    { name },
    { name: required('name', 'Token name') },
  );

  const create = handleSubmit(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ secret: string }>(`/partners/${partnerId}/tokens`, {
        method: 'POST',
        body: { name: name.trim() },
      });
      setIssued({ name: name.trim(), secret: res.secret });
      setName('');
      reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the token.');
    } finally {
      setBusy(false);
    }
  });

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
          <code className="mt-2 block overflow-x-auto overscroll-x-contain rounded border border-amber-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900">
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

      <form onSubmit={create} className="mt-4 flex flex-wrap items-end gap-3" noValidate>
        <Field label="New token name" hint="Names the integration, not the person." error={errorFor('name')}>
          <TextInput
            aria-label="New token name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={blurHandler('name')}
            placeholder="Portfolio sync"
            required
            className="!w-72"
          />
        </Field>
        <Button type="submit" disabled={busy}>
          Issue token
        </Button>
      </form>

      {live.length === 0 ? (
        <p className="mt-4 text-sm text-ink-400">No active tokens.</p>
      ) : (
        <div className="mt-4 overflow-x-auto overscroll-x-contain">
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

  const claim = useLatestOnly();

  useEffect(() => {
    // Two clicks of the pager put two pages in flight, and the slower one wins
    // if it replies second: page 2's engagements beneath a pager reading 3,
    // with nothing coming to correct it. See `useLatestOnly`.
    const current = claim();
    api<{ valuations: PartnerValuation[]; total: number }>(
      `/partners/${partnerId}/valuations?page=${page}&per_page=10`,
    )
      .then((d) => {
        if (!current()) return;
        setRows(d.valuations);
        setTotal(d.total);
      })
      .catch(() => current() && setError('Could not load this partner’s engagements.'));
  }, [partnerId, page, claim]);

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
          <div className="mt-3 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[620px] text-sm" aria-label="Partner engagements">
              <thead>
                <tr className="sr-only">
                  <th scope="col">Company</th>
                  <th scope="col">Type</th>
                  <th scope="col">State</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
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

  /*
   * `:id` changes without this page being torn down, so two firms can be in
   * flight at once. The late reply does not just relabel a heading: it seeds
   * every form on this page — brand colour, logo, subdomain, the CC list and
   * the email templates — from the other firm's record, under this firm's name.
   * Saving then writes one partner's branding onto another's. See
   * `useLatestOnly`.
   */
  const claim = useLatestOnly();

  const load = useCallback(async () => {
    const current = claim();
    try {
      const { partner: p } = await api<{ partner: PartnerDetail }>(`/partners/${id}`);
      if (!current()) return;
      setPartner(p);
      setBrandColor(p.brand_color ?? '');
      setLogoUrl(p.logo_url ?? '');
      setTemplates(p.email_templates ?? {});
      setSubdomain(p.subdomain ?? '');
      // One address per line: a comma-separated field invites a trailing
      // comma, and a trailing comma is an empty address the API rejects.
      setCcEmails((p.cc_emails ?? []).join('\n'));
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof ApiError && err.status === 404
          ? 'This partner does not exist.'
          : 'Could not load the partner.',
      );
    }
  }, [id, claim]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Three forms share this page, each with a different amount of nothing
   * checking it: the subdomain box carried no constraint at all, the brand
   * colour carried a `pattern` attribute on a form that had already told the
   * browser not to look, and the email-template rows silently dropped anything
   * half-filled at submit time. Every rule below restates one the PATCH route
   * already enforces — the whole gain is saying so beside the box instead of
   * after the round trip.
   *
   * These sit above the loading branches because they are hooks: the page
   * returns a spinner until the partner arrives, and a hook called after that
   * return is a hook that is not always called.
   */
  const terms = useFormValidation(
    { subdomain, ccEmails },
    {
      // Case and surrounding whitespace are forgiven server-side, so they are
      // forgiven here — rejecting "Acme " when the route would have taken it
      // is pedantry the route itself declined to commit.
      subdomain: optional('subdomain', (v) =>
        /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$/.test(String(v.subdomain).trim().toLowerCase())
          ? null
          : 'A subdomain is 3–63 characters of a–z, 0–9 and hyphens, not starting or ending with one.',
      ),
      // Named rather than counted: "one of these ten is wrong" sends the admin
      // back to read all ten.
      ccEmails: (v) => {
        const list = String(v.ccEmails)
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean);
        const bad = list.find((address) => !isEmailAddress(address));
        if (bad) return `“${bad}” is not an email address.`;
        return list.length > 10 ? 'At most 10 CC addresses — this is a mailing list, not a mailshot.' : null;
      },
    },
  );

  const branding = useFormValidation(
    { brandColor, logoUrl },
    {
      // Both are optional: blank clears the override back to the platform's
      // own look, which is why neither carries a `required` rule.
      brandColor: pattern('brandColor', /#[0-9a-fA-F]{6}/, 'Use a six-digit hex colour, e.g. #1f6f54.'),
      logoUrl: optional('logoUrl', (v) => {
        try {
          new URL(String(v.logoUrl).trim());
          return null;
        } catch {
          return 'Enter a full URL, starting with https://.';
        }
      }),
    },
  );

  /*
   * One rule per template rather than per box, because the thing that can be
   * wrong spans the pair: a subject with no body was being dropped on the way
   * out, so an admin who filled in half a row was shown a saved page with
   * their text gone and nothing to say it had been discarded.
   */
  const templateValues = useMemo<Record<string, TemplatePair>>(
    () =>
      Object.fromEntries(PARTNER_EMAIL_TEMPLATE_KEYS.map((key) => [key, templates[key] ?? EMPTY_TEMPLATE])),
    [templates],
  );

  const templateRules = useMemo<Rules<Record<string, TemplatePair>>>(
    () =>
      Object.fromEntries(
        PARTNER_EMAIL_TEMPLATE_KEYS.map((key) => [
          key,
          (values: Record<string, TemplatePair>) => {
            const pair = values[key] ?? EMPTY_TEMPLATE;
            const subject = pair.subject.trim();
            const body = pair.body.trim();
            if (subject && !body) return 'Add a body — a subject on its own is not saved.';
            if (body && !subject) return 'Add a subject — a body on its own is not saved.';
            return null;
          },
        ]),
      ),
    [],
  );

  const emailTemplates = useFormValidation(templateValues, templateRules);

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

  const saveBranding = branding.handleSubmit(() =>
    patch(
      { brand_color: brandColor.trim() || null, logo_url: logoUrl.trim() || null },
      'Could not save the branding.',
    ),
  );

  const saveTerms = terms.handleSubmit(() =>
    patch(
      {
        subdomain: subdomain.trim() || null,
        cc_emails: ccEmails
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
      },
      'Could not save the commercial terms.',
    ),
  );

  const saveTemplates = emailTemplates.handleSubmit(() => {
    // Only complete overrides are sent; a row left entirely blank is the
    // "use the platform default" case, and half-filled rows can no longer
    // reach here.
    const filled = Object.fromEntries(
      Object.entries(templates).filter(([, t]) => t.subject.trim() !== '' && t.body.trim() !== ''),
    );
    return patch({ email_templates: filled }, 'Could not save the email templates.');
  });

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

      <PartnerQueue partner={partner} />

      {/* The saved entry point (design §4.4). A firm's queue reconstructed
          from a dropdown every morning is not an entry point; pinned once, it
          is in the saved-views strip for the whole ops team. */}
      <PinPartnerView partnerId={partner.id} partnerName={partner.name} />

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
          <div className="mt-3 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[560px] text-sm" aria-label="Partner users">
              <thead>
                <tr className="sr-only">
                  <th scope="col">User</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
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
        <form onSubmit={saveTerms} className="mt-4 space-y-4" noValidate>
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="Subdomain"
              hint="3–63 characters of a–z, 0–9 and hyphens. Blank keeps them on the platform's own address."
              error={terms.errorFor('subdomain')}
            >
              <TextInput
                aria-label="Subdomain"
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                onBlur={terms.blurHandler('subdomain')}
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
            error={terms.errorFor('ccEmails')}
          >
            <textarea
              aria-label="CC addresses"
              value={ccEmails}
              onChange={(e) => setCcEmails(e.target.value)}
              onBlur={terms.blurHandler('ccEmails')}
              rows={3}
              placeholder="filings@yourfirm.com"
              className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 font-mono text-xs text-ink-900 placeholder:text-ink-400 focus:border-bond-500 focus:ring-2 focus:ring-bond-100 focus:outline-none"
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
          <form onSubmit={saveBranding} className="flex flex-wrap items-end gap-3" noValidate>
            <Field label="Brand colour" hint="Hex, e.g. #1f6f54." error={branding.errorFor('brandColor')}>
              <TextInput
                aria-label="Brand colour"
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                onBlur={branding.blurHandler('brandColor')}
                placeholder="#1f6f54"
                pattern="#[0-9a-fA-F]{6}"
                className="!w-32"
              />
            </Field>
            <Field label="Logo URL" error={branding.errorFor('logoUrl')}>
              <TextInput
                aria-label="Logo URL"
                type="url"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                onBlur={branding.blurHandler('logoUrl')}
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
        <form className="mt-5 space-y-6" onSubmit={saveTemplates} noValidate>
          {PARTNER_EMAIL_TEMPLATE_KEYS.map((key) => {
            const t = templates[key] ?? EMPTY_TEMPLATE;
            const set = (field: 'subject' | 'body', value: string) =>
              setTemplates((prev) => ({ ...prev, [key]: { ...t, [field]: value } }));
            const pairError = emailTemplates.errorFor(key);
            const errorId = `${key}-template-error`;
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
                    onBlur={emailTemplates.blurHandler(key)}
                    aria-invalid={pairError ? true : undefined}
                    aria-describedby={pairError ? errorId : undefined}
                  />
                  <textarea
                    aria-label={`${TEMPLATE_LABELS[key] ?? key} body`}
                    placeholder="Body (platform default)"
                    value={t.body}
                    onChange={(e) => set('body', e.target.value)}
                    onBlur={emailTemplates.blurHandler(key)}
                    aria-invalid={pairError ? true : undefined}
                    aria-describedby={pairError ? errorId : undefined}
                    rows={3}
                    className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-bond-500 focus:ring-2 focus:ring-bond-100 focus:outline-none"
                  />
                  {/*
                   * One message for the pair, because the rule is about the
                   * pair — neither box is wrong on its own.
                   *
                   * `role="alert"` as well as the `aria-describedby` above: the
                   * message appears on submit, when focus is on the Save button
                   * and not on either box, so being reachable from the controls
                   * is not the same as being announced.
                   */}
                  {pairError && (
                    <p id={errorId} role="alert" className="text-xs font-medium text-red-600">
                      {pairError}
                    </p>
                  )}
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
