import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatPerShare, moneyFormatter } from '../lib/format';
import { HelpIcon } from '../components/HelpIcon';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  ListTruncationNote,
  LoadError,
  LoadingBlock,
  Select,
  SkeletonStatStrip,
  SkeletonTable,
  Spinner,
  TextInput,
  useRetry,
} from '../components/ui';
import { useLatestOnly } from '../lib/useLatestOnly';

/** Engine equity/FMV values are in whole currency units (dollars), not cents. */
const usd = (v: number, currency: string) => moneyFormatter(currency, { maximumFractionDigits: 0 })(v);
// The per-share column. It was `usdPrecise`, struck at two decimals — neither
// USD-agnostic nor precise: the figure it prints is a concluded 409A per-share
// value, and the roll-up showed it a fourth decimal short of the report each
// subsidiary was actually issued. Named for the figure now, so it cannot be
// reached for by the next column that merely wants more digits than `usd`.
const perShare = (v: number, currency: string) => formatPerShare(v, currency);

/**
 * The server's caption dropped into the middle of a sentence.
 *
 * `headlineLabels` writes each figure the way an exhibit heads a column
 * — "Total expense", "Concluded value of the transferred interest" — and those
 * are the exact words the deliverable uses, so they are kept rather than
 * paraphrased. Only the leading capital is wrong mid-sentence. An
 * acronym-initial caption would be spoiled by folding it, so only a word whose
 * second letter is already lower-case is folded.
 */
const lowerFirst = (text: string): string =>
  /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;

interface Organization {
  id: string;
  name: string;
  entity_type: string;
}
/**
 * What one row's headline figure actually is, shipped by the server.
 *
 * The two money columns are headed with the 409A names of the columns behind
 * them, and every specialty engine writes into those same two columns — so an
 * IFRS 2 row's figure is a total share-based-payment expense and an EMI row's
 * per-share figure is the restricted AMV, neither of which the heading names.
 * The caption travels with the row because a heading cannot vary per row, and
 * `is_default` is the server's answer rather than a comparison against a
 * restated copy of the 409A wording here. Optional: an older API build sends
 * neither, and then the headings are all there is.
 */
interface FigureLabel {
  /** The deliverable's own words, or null when the kind concludes no such figure. */
  caption: string | null;
  /** True when the caption is the default 409A wording the column heading carries. */
  is_default: boolean;
}
interface Entity {
  valuation_id: string;
  number: string;
  company_name: string;
  entity_type: string;
  parent_valuation_id: string | null;
  state: string;
  equity_value: number | null;
  fmv_per_share: number | null;
  currency: string;
  equity_figure?: FigureLabel;
  per_share_figure?: FigureLabel;
}
interface CurrencyTotals {
  currency: string;
  entity_count: number;
  valued_count: number;
  total_equity_value: number;
  consolidated_equity_value: number;
}
interface Consolidated {
  entity_count: number;
  valued_count: number;
  /** Null when the organization spans more than one currency. */
  total_equity_value: number | null;
  consolidated_equity_value: number | null;
  by_currency?: CurrencyTotals[];
  currencies: string[];
  mixed_currency?: boolean;
  /** Subsidiaries whose parent is not in this roll-up, so nothing eliminated them. */
  unanchored_subsidiaries?: Array<{ valuation_id: string; company_name: string }>;
  /**
   * Entities whose latest run concluded something that is not this entity's
   * equity — an IFRS 2 total expense, an ASC 820 portfolio total, a gift &
   * estate transferred-interest value. Excluded from every figure below.
   * Optional: an older API build does not send it.
   */
  non_equity_entities?: Array<{
    valuation_id: string;
    company_name: string;
    kind: string;
    figure: string | null;
  }>;
}
interface OrgDetail {
  organization: Organization;
  entities: Entity[];
  consolidated: Consolidated;
  /** The entity list hit its cap — the roll-up below covers only what is listed. */
  truncated?: boolean;
  entity_page_limit?: number;
}

const ENTITY_LABELS: Record<string, string> = {
  holding_company: 'Holding company',
  fund: 'Fund',
  operating_group: 'Operating group',
};

/**
 * Multi-entity portfolio (feature 6): list organizations (holding companies /
 * funds), create new ones, and view a selected org's consolidated roll-up and
 * member entities.
 */
export function PortfolioPage() {
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [name, setName] = useState('');
  const [type, setType] = useState('holding_company');
  const [busy, setBusy] = useState(false);
  const [orgsTruncated, setOrgsTruncated] = useState(false);

  const claim = useLatestOnly();

  const loadOrgs = useCallback(async () => {
    try {
      const r = await api<{ organizations: Organization[]; truncated: boolean }>('/organizations');
      setOrgs(r.organizations);
      // The chips below are the only way into an organization's roll-up, so a
      // capped list is a portfolio with no route to it — the outer half of the
      // truncation this page already reports for the entities *within* one.
      setOrgsTruncated(r.truncated);
      if (r.organizations.length > 0 && !selected) setSelected(r.organizations[0]!.id);
    } catch {
      setError('Could not load organizations.');
    }
  }, [selected]);

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs, token]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    // The organization list is a click-to-switch sidebar, so two details can be
    // outstanding at once. A late reply for the previously selected entity
    // renders its holdings, its subsidiaries and its consolidated figures under
    // the name of the one now highlighted. See `useLatestOnly`.
    /*
     * The sidebar is the question and this panel is the answer to it. Without
     * dropping the previous organization's detail here, switching entity left
     * its holdings, its subsidiaries and its consolidated equity figure sitting
     * under the newly highlighted name for a whole round trip — a total someone
     * reads off this screen and puts in a board pack, filed under the wrong
     * portfolio. `useLatestOnly` below orders the replies; this covers the wait.
     */
    setDetail(null);
    const current = claim();
    api<OrgDetail>(`/organizations/${selected}`)
      .then((d) => current() && setDetail(d))
      .catch(() => current() && setError('Could not load the organization.'));
  }, [selected, claim]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ organization: Organization }>('/organizations', {
        method: 'POST',
        body: { name: name.trim(), entity_type: type },
      });
      setName('');
      await loadOrgs();
      setSelected(r.organization.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the organization.');
    } finally {
      setBusy(false);
    }
  };

  if (!orgs) return error ? <LoadError message={error} {...retryProps} /> : <Spinner />;

  // Only meaningful for a single-currency organization; a mixed one gets a
  // per-currency breakdown below instead of one mislabelled sum.
  const currency = detail?.consolidated.currencies[0] ?? 'USD';
  const mixed = detail?.consolidated.mixed_currency ?? false;
  const byCurrency = detail?.consolidated.by_currency ?? [];

  return (
    <div className="max-w-5xl">
      <div className="overline flex items-center gap-1.5 text-ink-400">
        Portfolio
        <HelpIcon article="organizations-overview" />
      </div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Entities & funds</h1>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <form
        onSubmit={create}
        className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-paper-300 bg-surface p-5 shadow-card"
      >
        <Field label="New organization">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Holdings" />
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="Organization type">
            <option value="holding_company">Holding company</option>
            <option value="fund">Fund</option>
            <option value="operating_group">Operating group</option>
          </Select>
        </Field>
        <Button type="submit" disabled={busy || !name.trim()}>
          Create
        </Button>
      </form>

      {orgs.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No organizations yet">
            Create a holding company or fund to group valuations into a portfolio.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap gap-2">
            {orgs.map((o) => (
              <button
                key={o.id}
                onClick={() => setSelected(o.id)}
                aria-pressed={selected === o.id}
                className={`tap-area rounded-full px-3.5 py-1.5 text-sm font-semibold ${
                  selected === o.id
                    ? 'bg-bond-700 text-paper-50'
                    : 'bg-paper-100 text-ink-600 hover:bg-paper-200'
                }`}
              >
                {o.name}
              </button>
            ))}
          </div>
          <ListTruncationNote truncated={orgsTruncated} shown={orgs.length} noun="organizations" />

          {!detail && !error && (
            <LoadingBlock label="Loading organization…" className="mt-6">
              <SkeletonStatStrip count={4} />
              <SkeletonTable columns={5} rows={4} />
            </LoadingBlock>
          )}

          {detail && (
            <div className="mt-6 space-y-6">
              {/* A consolidated equity figure is read as the portfolio's total.
                  When the entity list was capped it is the total of a prefix,
                  and nothing else on the page says so. */}
              {detail.truncated && (
                <ErrorNote>
                  This organization holds more than {detail.entity_page_limit ?? 500} entities. Only the first{' '}
                  {detail.entities.length} are listed, and the consolidated figures below cover only those.
                </ErrorNote>
              )}
              {/* "Consolidated equity" is read as "the group, without double
                  counting". It is only that while every subsidiary's parent is
                  in the roll-up; one whose parent is missing is counted in
                  full, which is the honest answer and not the one the label
                  implies. Said here rather than left to be inferred from a
                  figure that looks ordinary either way. */}
              {(detail.consolidated.unanchored_subsidiaries?.length ?? 0) > 0 && (
                <ErrorNote>
                  {detail.consolidated.unanchored_subsidiaries!.length === 1
                    ? `${detail.consolidated.unanchored_subsidiaries![0]!.company_name} is marked a subsidiary but its parent is not in this organization, so its equity is counted in full below.`
                    : `${detail.consolidated.unanchored_subsidiaries!.length} entities are marked subsidiaries but their parents are not in this organization, so their equity is counted in full below: ${detail.consolidated
                        .unanchored_subsidiaries!.map((e) => e.company_name)
                        .join(', ')}.`}{' '}
                  Set each one&rsquo;s parent on its engagement to consolidate it.
                </ErrorNote>
              )}
              {/* An engagement can belong to this organization and still
                  conclude something no roll-up can add up — an IFRS 2 total
                  expense, an ASC 820 portfolio total, the value of a
                  transferred interest. Every one of those is positive, so a
                  total that silently included them looked ordinary — and one
                  that now excludes them looks equally ordinary. Naming the
                  entity *and* the figure is what lets a reader tell this from
                  an engagement nobody has valued yet. */}
              {(detail.consolidated.non_equity_entities?.length ?? 0) > 0 && (
                <ErrorNote>
                  {detail.consolidated.non_equity_entities!.length === 1
                    ? `${detail.consolidated.non_equity_entities![0]!.company_name} concluded ${lowerFirst(
                        detail.consolidated.non_equity_entities![0]!.figure ??
                          'a figure that is not an equity value',
                      )}, not an equity value, so it is excluded from the totals below.`
                    : `${detail.consolidated.non_equity_entities!.length} entities concluded figures that are not equity values, so they are excluded from the totals below: ${detail.consolidated
                        .non_equity_entities!.map(
                          (e) => `${e.company_name} (${lowerFirst(e.figure ?? 'not an equity value')})`,
                        )
                        .join(', ')}.`}
                </ErrorNote>
              )}
              <div className="flex flex-wrap gap-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
                <Metric label="Entities" value={String(detail.consolidated.entity_count)} />
                <Metric label="Valued" value={String(detail.consolidated.valued_count)} />
                {mixed ? (
                  <Metric label="Total equity" value="Mixed currencies" hint="Broken out by currency below" />
                ) : (
                  <>
                    <Metric
                      label="Total equity"
                      value={usd(detail.consolidated.total_equity_value ?? 0, currency)}
                    />
                    <Metric
                      label="Consolidated equity"
                      value={usd(detail.consolidated.consolidated_equity_value ?? 0, currency)}
                      hint={
                        (detail.consolidated.unanchored_subsidiaries?.length ?? 0) > 0
                          ? 'Consolidated subsidiaries excluded'
                          : 'Subsidiaries excluded'
                      }
                    />
                  </>
                )}
                <Metric
                  label="Type"
                  value={ENTITY_LABELS[detail.organization.entity_type] ?? detail.organization.entity_type}
                />
              </div>

              {mixed && byCurrency.length > 0 && (
                <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
                  <h2 className="font-display text-lg font-semibold text-ink-900">Equity by currency</h2>
                  <p className="mt-1 text-sm text-ink-500">
                    These entities are held in {byCurrency.length} currencies, so there is no single
                    consolidated total. Convert at your own reporting rate.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-6">
                    {byCurrency.map((c) => (
                      <Metric
                        key={c.currency}
                        label={`${c.currency} total`}
                        value={usd(c.total_equity_value, c.currency)}
                        hint={`${usd(c.consolidated_equity_value, c.currency)} excluding subsidiaries`}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section className="overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
                <table className="w-full min-w-[640px] text-sm">
                  <caption className="sr-only">Portfolio companies</caption>
                  <thead>
                    <tr className="border-b border-paper-300 text-left">
                      <th className="overline px-4 py-3 font-semibold text-ink-400">Company</th>
                      <th className="overline px-4 py-3 font-semibold text-ink-400">Role</th>
                      <th className="overline px-4 py-3 font-semibold text-ink-400">State</th>
                      <th className="overline px-4 py-3 text-right font-semibold text-ink-400">
                        Equity value
                      </th>
                      <th className="overline px-4 py-3 text-right font-semibold text-ink-400">FMV/share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.entities.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-ink-400">
                          No entities assigned yet. Add valuations to this organization from a valuation's
                          Overview.
                        </td>
                      </tr>
                    ) : (
                      detail.entities.map((e) => (
                        <tr key={e.valuation_id} className="border-b border-paper-200 last:border-0">
                          <td className="px-4 py-2.5">
                            <Link
                              to={`/valuations/${e.valuation_id}`}
                              className="font-semibold text-bond-600 hover:text-bond-700"
                            >
                              {e.company_name}
                            </Link>
                            <span className="ml-2 text-xs text-ink-400">{e.number}</span>
                          </td>
                          <td className="px-4 py-2.5 text-ink-600">{e.entity_type}</td>
                          <td className="px-4 py-2.5 text-ink-600">{e.state}</td>
                          <FigureCell
                            value={e.equity_value}
                            label={e.equity_figure}
                            format={(v) => usd(v, e.currency)}
                          />
                          <FigureCell
                            value={e.fmv_per_share}
                            label={e.per_share_figure}
                            format={(v) => perShare(v, e.currency)}
                          />
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One money cell under a heading that may not describe it.
 *
 * Three cases, and the middle one is the bug this exists for:
 *
 *   * `caption === null` — the kind concluded no such figure (a QSBS
 *     attestation concludes neither). Nothing is printed even if the column
 *     behind it somehow holds a number, because a figure under a heading that
 *     was never asked of it is worse than a dash.
 *   * a caption that is not the default — the figure is real and is *not* what
 *     the heading says. It is printed with its own words beneath it: "Total
 *     expense", "Actual market value (AMV) per share".
 *   * the default caption — the heading is already right, so nothing is added.
 *     This is every 409A row, which is nearly every row.
 */
function FigureCell({
  value,
  label,
  format,
}: {
  value: number | null;
  label?: FigureLabel;
  format: (v: number) => string;
}) {
  const concluded = label ? label.caption !== null : true;
  return (
    <td className="tnum px-4 py-2.5 text-right text-ink-900">
      {value === null || !concluded ? '—' : format(value)}
      {value !== null && concluded && label && !label.is_default && (
        <div className="mt-0.5 text-xs font-normal text-ink-400">{label.caption}</div>
      )}
    </td>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="overline text-ink-400">{label}</div>
      <div className="tnum mt-1 font-display text-2xl font-semibold text-ink-900">{value}</div>
      {hint && <div className="text-xs text-ink-400">{hint}</div>}
    </div>
  );
}
