import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { moneyFormatter } from '../lib/format';
import { HelpIcon } from '../components/HelpIcon';
import { Button, EmptyState, ErrorNote, Field, Select, Spinner, TextInput } from '../components/ui';

/** Engine equity/FMV values are in whole currency units (dollars), not cents. */
const usd = (v: number, currency: string) => moneyFormatter(currency, { maximumFractionDigits: 0 })(v);
const usdPrecise = (v: number, currency: string) => moneyFormatter(currency, { minimumFractionDigits: 2 })(v);

interface Organization {
  id: string;
  name: string;
  entity_type: string;
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
  const [name, setName] = useState('');
  const [type, setType] = useState('holding_company');
  const [busy, setBusy] = useState(false);

  const loadOrgs = useCallback(async () => {
    try {
      const r = await api<{ organizations: Organization[] }>('/organizations');
      setOrgs(r.organizations);
      if (r.organizations.length > 0 && !selected) setSelected(r.organizations[0]!.id);
    } catch {
      setError('Could not load organizations.');
    }
  }, [selected]);

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    api<OrgDetail>(`/organizations/${selected}`)
      .then(setDetail)
      .catch(() => setError('Could not load the organization.'));
  }, [selected]);

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

  if (!orgs) return error ? <ErrorNote>{error}</ErrorNote> : <Spinner />;

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
                className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ${
                  selected === o.id
                    ? 'bg-bond-700 text-paper-50'
                    : 'bg-paper-100 text-ink-600 hover:bg-paper-200'
                }`}
              >
                {o.name}
              </button>
            ))}
          </div>

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
                      hint="Subsidiaries excluded"
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

              <section className="overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
                <table className="w-full min-w-[640px] text-sm">
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
                          <td className="tnum px-4 py-2.5 text-right text-ink-900">
                            {e.equity_value === null ? '—' : usd(e.equity_value, e.currency)}
                          </td>
                          <td className="tnum px-4 py-2.5 text-right text-ink-900">
                            {e.fmv_per_share === null ? '—' : usdPrecise(e.fmv_per_share, e.currency)}
                          </td>
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

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="overline text-ink-400">{label}</div>
      <div className="tnum mt-1 font-display text-2xl font-semibold text-ink-900">{value}</div>
      {hint && <div className="text-xs text-ink-400">{hint}</div>}
    </div>
  );
}
