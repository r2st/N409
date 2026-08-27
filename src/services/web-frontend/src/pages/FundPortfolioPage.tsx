import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import {
  all,
  integer,
  numberMin,
  numberRange,
  optional,
  pattern,
  required,
  useFormValidation,
  type Rules,
} from '../lib/useFormValidation';
import { moneyFormatter } from '../lib/format';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  InfoTooltip,
  ListTruncationNote,
  LoadError,
  Select,
  Spinner,
  TextInput,
  useRetry,
} from '../components/ui';
import { HelpIcon } from '../components/HelpIcon';

/**
 * ASC 820 Fund Portfolio (feature: ASC 820 Fund Holdings). Distinct from the
 * corporate-group consolidation on /portfolio: here an investment fund marks a
 * portfolio of positions to fair value, levels them (ASC 820 1/2/3), rolls them
 * into NAV and distributes through an LP waterfall. Ops-only.
 */

const money = (v: number, currency: string) => moneyFormatter(currency, { maximumFractionDigits: 0 })(v);

interface Fund {
  id: string;
  name: string;
  fund_type: string;
  currency: string;
  vintage_year: number | null;
}
interface Mark {
  id: string;
  measurement_date: string;
  method: string;
  fair_value: string;
  level: number;
}
interface Position {
  id: string;
  company_name: string;
  security_type: string;
  quantity: string;
  cost_basis: string;
  mark_method: string;
  latest_mark: Mark | null;
}
interface LpTerms {
  committed_capital: string;
  contributed_capital: string;
  preferred_return_rate: string;
  carry_pct: string;
  gp_catch_up: boolean;
}
interface FundDetail {
  fund: Fund;
  lp_terms: LpTerms | null;
  positions: Position[];
  /** More holdings exist than this page carries; see FUND_POSITION_PAGE_LIMIT. */
  truncated: boolean;
}
interface Nav {
  net_asset_value: number;
  gross_asset_value: number;
  total_cost_basis: number;
  total_unrealized_gain: number;
  liabilities: number;
  level_breakdown: { level_1: number; level_2: number; level_3: number };
}
interface Waterfall {
  distributable: number;
  lp_distribution: number;
  gp_distribution: number;
  clawback_owed: number;
  tiers: Record<string, number>;
}

export function FundPortfolioPage() {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [form, setForm] = useState({ name: '', fund_type: 'vc', currency: 'USD', vintage_year: '2024' });
  /**
   * A create in flight. `funds` and `fund_positions` carry no uniqueness of
   * their own (migration 0086), so a second submit before the first answers is
   * a second row — and the panel only closes once the first one returns, so the
   * button stayed live for the whole round trip. Every other write on this page
   * already refuses re-entry; these two were the exceptions.
   */
  const [creating, setCreating] = useState(false);

  const loadFunds = useCallback(async () => {
    setLoading(true);
    try {
      const { funds: f, truncated: capped } = await api<{ funds: Fund[]; truncated: boolean }>('/funds');
      setFunds(f);
      // These chips are the only route into a fund's mark-to-fair-value view,
      // so a capped list is a fund with no way to reach it — the same shape
      // the organization chips on PortfolioPage have.
      setTruncated(capped);
      if (f.length > 0 && !selected) setSelected(f[0]!.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load funds');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void loadFunds();
  }, [loadFunds]);

  const { errorFor, blurHandler, handleSubmit, reset } = useFormValidation(form, {
    name: required('name', 'Fund name'),
    currency: all(
      required('currency', 'Currency'),
      pattern('currency', /[A-Za-z]{3}/, 'Currency must be a three-letter ISO 4217 code, like USD.'),
    ),
    // Blank is sent as null: a vintage the fund has not recorded is a normal
    // state, so the rule only says what a year must look like when given.
    vintage_year: optional(
      'vintage_year',
      all(numberRange('vintage_year', 1900, 2100, 'Vintage'), integer('vintage_year', 'Vintage')),
    ),
  });

  const create = handleSubmit(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const { fund } = await api<{ fund: Fund }>('/funds', {
        method: 'POST',
        body: {
          name: form.name,
          fund_type: form.fund_type,
          currency: form.currency.toUpperCase(),
          vintage_year: form.vintage_year ? Number(form.vintage_year) : null,
        },
      });
      setShowCreate(false);
      setForm({ name: '', fund_type: 'vc', currency: 'USD', vintage_year: '2024' });
      // The panel is reopened for the next fund, so the refilled defaults must
      // not arrive already carrying the last attempt's messages.
      reset();
      await loadFunds();
      setSelected(fund.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create fund');
    } finally {
      setCreating(false);
    }
  });

  if (loading) return <Spinner />;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-1">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-ink-800">
            Fund Portfolios
            <HelpIcon article="fund-holdings-overview" label="Help: Fund holdings & ASC 820" />
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            ASC 820 fair-value marks, NAV and LP waterfall for investment funds.
          </p>
        </div>
        <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? 'Cancel' : 'New fund'}</Button>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {showCreate && (
        <form
          onSubmit={create}
          className="flex flex-wrap items-end gap-3 rounded-lg border border-paper-200 bg-surface p-4"
          noValidate
        >
          <Field label="Fund name" error={errorFor('name')}>
            <TextInput
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              onBlur={blurHandler('name')}
              required
            />
          </Field>
          <Field label="Type">
            <Select value={form.fund_type} onChange={(e) => setForm({ ...form, fund_type: e.target.value })}>
              <option value="vc">Venture</option>
              <option value="pe">Private equity</option>
              <option value="credit">Credit</option>
              <option value="growth">Growth</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Field label="Currency" error={errorFor('currency')}>
            <TextInput
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
              onBlur={blurHandler('currency')}
              className="w-20"
              required
            />
          </Field>
          <Field label="Vintage" error={errorFor('vintage_year')}>
            <TextInput
              value={form.vintage_year}
              onChange={(e) => setForm({ ...form, vintage_year: e.target.value })}
              onBlur={blurHandler('vintage_year')}
              className="w-24"
              required
            />
          </Field>
          <Button type="submit" disabled={creating}>
            Create
          </Button>
        </form>
      )}

      {funds.length === 0 ? (
        <EmptyState title="No funds yet">
          Create a fund to start marking its portfolio to fair value.
        </EmptyState>
      ) : (
        <div className="flex flex-wrap gap-2">
          {funds.map((f) => (
            <button
              key={f.id}
              onClick={() => setSelected(f.id)}
              aria-pressed={selected === f.id}
              className={`tap-area rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                selected === f.id
                  ? 'border-bond-600 bg-bond-50 text-bond-700'
                  : 'border-paper-300 text-ink-600 hover:bg-paper-100'
              }`}
            >
              {f.name} <span className="text-ink-400">· {f.fund_type.toUpperCase()}</span>
            </button>
          ))}
        </div>
      )}
      <ListTruncationNote truncated={truncated} shown={funds.length} noun="funds" />

      {selected && (
        <FundDetailView
          key={selected}
          fundId={selected}
          onChanged={() => void loadFunds()}
          onDeleted={() => {
            // Clear the selection first: the detail panel for a fund that no
            // longer exists would reload into a 404 and render its error.
            setSelected(null);
            void loadFunds();
          }}
        />
      )}
    </div>
  );
}

function FundDetailView({
  fundId,
  onChanged,
  onDeleted,
}: {
  fundId: string;
  /** A rename lands in the chips above, which hold their own copy of the row. */
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [detail, setDetail] = useState<FundDetail | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [nav, setNav] = useState<Nav | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [showPos, setShowPos] = useState(false);
  /** See `creating` on the page above — the same re-entry, one row lower. */
  const [adding, setAdding] = useState(false);
  const [posForm, setPosForm] = useState({
    company_name: '',
    security_type: 'preferred',
    quantity: '0',
    cost_basis: '0',
    mark_method: 'cost',
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await api<FundDetail>(`/funds/${fundId}`);
      setDetail(d);
      if (d.positions.length > 0) {
        const navRes = await api<{ nav: Nav }>(`/funds/${fundId}/nav`);
        setNav(navRes.nav);
      } else {
        setNav(null);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load fund');
    }
  }, [fundId]);

  useEffect(() => {
    void load();
  }, [load, token]);

  /**
   * Rename the portfolio.
   *
   * `POST /funds` was the only write that ever touched a fund's own fields, so
   * a portfolio created with a typo carried it for good: the chips above, the
   * NAV header and any report the fund is linked to all read this one string.
   */
  const rename = async () => {
    const name = renaming?.trim();
    if (!name || name === detail?.fund.name) return setRenaming(null);
    setError(null);
    try {
      await api(`/funds/${fundId}`, { method: 'PATCH', body: { name } });
      setRenaming(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Rename failed');
    }
  };

  /**
   * Delete the portfolio, after confirming — this takes every holding and its
   * whole mark trail with it (both cascade from `fund_portfolios`). The API
   * refuses outright while the fund is linked to an engagement; that 409's own
   * message is what shows here, because it names the thing to do about it.
   */
  const remove = async () => {
    if (!detail) return;
    if (!window.confirm(`Delete “${detail.fund.name}”, its holdings and their whole mark history?`)) return;
    setDeleting(true);
    setError(null);
    try {
      await api(`/funds/${fundId}`, { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Delete failed');
      setDeleting(false);
    }
  };

  /*
   * `quantity` and `cost_basis` are plain text boxes read with `Number(...)`,
   * so "1,200" became NaN and was posted as null. The rules say what shape the
   * box wants rather than letting a mistyped holding reach the fund's NAV as
   * an absence.
   */
  const positionForm = useFormValidation(posForm, {
    company_name: required('company_name', 'Company'),
    quantity: numberMin('quantity', 0, 'Quantity'),
    cost_basis: numberMin('cost_basis', 0, 'Cost basis'),
  });

  const addPosition = positionForm.handleSubmit(async () => {
    if (adding) return;
    setAdding(true);
    setError(null);
    try {
      await api(`/funds/${fundId}/positions`, {
        method: 'POST',
        body: {
          company_name: posForm.company_name,
          security_type: posForm.security_type,
          quantity: Number(posForm.quantity),
          cost_basis: Number(posForm.cost_basis),
          mark_method: posForm.mark_method,
        },
      });
      setShowPos(false);
      setPosForm({
        company_name: '',
        security_type: 'preferred',
        quantity: '0',
        cost_basis: '0',
        mark_method: 'cost',
      });
      positionForm.reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add position');
    } finally {
      setAdding(false);
    }
  });

  // The error has to be checked before the spinner, not inside the loaded
  // branch below it: a fund whose detail never arrives has `detail === null`
  // forever, so an error rendered only under `detail` is an error nobody sees.
  // A 403 or a deleted fund span the same failure as a slow network.
  if (error && !detail) return <LoadError message={error} {...retryProps} />;
  if (!detail) return <Spinner />;
  const { fund, positions } = detail;
  const cur = fund.currency;

  return (
    <div className="space-y-5">
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-paper-200 bg-surface p-4">
        {renaming === null ? (
          <>
            <div className="min-w-0">
              <div className="overline text-ink-400">Portfolio</div>
              <div className="truncate text-sm font-semibold text-ink-900">{fund.name}</div>
            </div>
            <div className="ml-auto flex gap-2">
              <Button
                variant="secondary"
                className="!px-3 !py-1.5 !text-xs"
                onClick={() => setRenaming(fund.name)}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                className="!px-3 !py-1.5 !text-xs"
                disabled={deleting}
                onClick={() => void remove()}
              >
                Delete
              </Button>
            </div>
          </>
        ) : (
          <>
            <Field label="Fund name">
              <TextInput value={renaming} onChange={(e) => setRenaming(e.target.value)} />
            </Field>
            <Button className="!px-3 !py-1.5 !text-xs" onClick={() => void rename()}>
              Save
            </Button>
            <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
          </>
        )}
      </div>

      {/* NAV summary */}
      {nav && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryCard label="Net asset value" value={money(nav.net_asset_value, cur)} accent />
          <SummaryCard label="Gross asset value" value={money(nav.gross_asset_value, cur)} />
          <SummaryCard label="Cost basis" value={money(nav.total_cost_basis, cur)} />
          <SummaryCard label="Unrealized gain" value={money(nav.total_unrealized_gain, cur)} />
        </div>
      )}

      {/* ASC 820 hierarchy disclosure */}
      {nav && (
        <div className="rounded-lg border border-paper-200 bg-surface p-4">
          <h2 className="mb-2 text-sm font-semibold text-ink-700">ASC 820 fair-value hierarchy</h2>
          <div className="overflow-x-auto overscroll-x-contain">
            <table className="w-full min-w-[420px] text-sm">
              <caption className="sr-only">Fair value hierarchy</caption>
              <thead>
                <tr className="border-b border-paper-300 text-left text-xs uppercase text-ink-500">
                  <th className="py-1.5">Level 1 (quoted)</th>
                  <th className="py-1.5">Level 2 (observable)</th>
                  <th className="py-1.5">Level 3 (unobservable)</th>
                </tr>
              </thead>
              <tbody className="tnum">
                <tr>
                  <td className="py-1.5">{money(nav.level_breakdown.level_1, cur)}</td>
                  <td className="py-1.5">{money(nav.level_breakdown.level_2, cur)}</td>
                  <td className="py-1.5">{money(nav.level_breakdown.level_3, cur)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Positions */}
      <div className="rounded-lg border border-paper-200 bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-700">Positions</h2>
          <Button variant="secondary" onClick={() => setShowPos((s) => !s)}>
            {showPos ? 'Cancel' : 'Add position'}
          </Button>
        </div>
        {showPos && (
          <form onSubmit={addPosition} className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3" noValidate>
            <Field label="Company" error={positionForm.errorFor('company_name')}>
              <TextInput
                value={posForm.company_name}
                onChange={(e) => setPosForm({ ...posForm, company_name: e.target.value })}
                onBlur={positionForm.blurHandler('company_name')}
                required
              />
            </Field>
            <Field label="Security">
              <Select
                value={posForm.security_type}
                onChange={(e) => setPosForm({ ...posForm, security_type: e.target.value })}
              >
                {['common', 'preferred', 'safe', 'note', 'warrant', 'other'].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Default mark method"
              tooltip="Sets the ASC 820 fair-value level: Market = Level 1 (quoted price), Last round = Level 2 (observable), Calibrated OPM and Cost = Level 3 (model / unobservable). Level 3 marks get the most auditor scrutiny."
            >
              <Select
                value={posForm.mark_method}
                onChange={(e) => setPosForm({ ...posForm, mark_method: e.target.value })}
              >
                <option value="cost">Cost</option>
                <option value="market">Market (L1)</option>
                <option value="last_round">Last round (L2)</option>
                <option value="calibrated_opm">Calibrated OPM (L3)</option>
              </Select>
            </Field>
            <Field label="Quantity" error={positionForm.errorFor('quantity')}>
              <TextInput
                value={posForm.quantity}
                onChange={(e) => setPosForm({ ...posForm, quantity: e.target.value })}
                onBlur={positionForm.blurHandler('quantity')}
              />
            </Field>
            <Field label="Cost basis" error={positionForm.errorFor('cost_basis')}>
              <TextInput
                value={posForm.cost_basis}
                onChange={(e) => setPosForm({ ...posForm, cost_basis: e.target.value })}
                onBlur={positionForm.blurHandler('cost_basis')}
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={adding}>
                Add
              </Button>
            </div>
          </form>
        )}
        {positions.length === 0 ? (
          <p className="text-sm text-ink-400">No positions. Add a holding to mark it to fair value.</p>
        ) : (
          <div className="space-y-2">
            {positions.map((p) => (
              <PositionRow key={p.id} fundId={fundId} position={p} currency={cur} onChange={load} />
            ))}
          </div>
        )}
        {/* NAV, the level breakdown and the unrealised-gain total above are all
            sums over these rows, so a capped page is an understated NAV rather
            than a short table. */}
        <ListTruncationNote
          truncated={detail.truncated}
          shown={positions.length}
          noun="holdings"
          hint="the NAV above covers only the holdings listed"
        />
      </div>

      <WaterfallCard fundId={fundId} lpTerms={detail.lp_terms} currency={cur} onSaved={load} />
    </div>
  );
}

function PositionRow({
  fundId,
  position,
  currency,
  onChange,
}: {
  fundId: string;
  position: Position;
  currency: string;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [marks, setMarks] = useState<Mark[] | null>(null);
  const [marksCapped, setMarksCapped] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [markForm, setMarkForm] = useState({
    measurement_date: '2026-03-31',
    method: 'market',
    quantity: position.quantity,
    quoted_price: '',
    round_price_per_share: '',
    model_value: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const loadMarks = useCallback(async () => {
    const { marks: m, truncated } = await api<{ marks: Mark[]; truncated: boolean }>(
      `/funds/${fundId}/positions/${position.id}/marks`,
    );
    setMarks(m);
    setMarksCapped(truncated);
  }, [fundId, position.id]);

  const toggle = () => {
    setOpen((o) => !o);
    if (!marks) void loadMarks();
  };

  /*
   * Only the box the chosen method actually reads is checked. A quoted price
   * left over from a market mark must not block a calibrated one, and each of
   * the three is read with `Number(...)` — a blank one posts 0, which is a
   * fair value of nothing rather than a missing input.
   */
  const markRules: Rules<typeof markForm> = {
    measurement_date: all(
      required('measurement_date', 'Date'),
      pattern('measurement_date', /\d{4}-\d{2}-\d{2}/, 'Date must be written as YYYY-MM-DD.'),
    ),
    ...(markForm.method === 'market'
      ? {
          quantity: numberMin<typeof markForm>('quantity', 0, 'Quantity'),
          quoted_price: numberMin<typeof markForm>('quoted_price', 0, 'Quoted price'),
        }
      : {}),
    ...(markForm.method === 'last_round'
      ? {
          quantity: numberMin<typeof markForm>('quantity', 0, 'Quantity'),
          round_price_per_share: numberMin<typeof markForm>('round_price_per_share', 0, 'Round price/sh'),
        }
      : {}),
    ...(markForm.method === 'calibrated_opm'
      ? { model_value: numberMin<typeof markForm>('model_value', 0, 'Model value') }
      : {}),
  };
  const mark = useFormValidation(markForm, markRules);

  const addMark = mark.handleSubmit(async () => {
    if (recording) return;
    setRecording(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        measurement_date: markForm.measurement_date,
        method: markForm.method,
      };
      if (markForm.method === 'market') {
        body.quantity = Number(markForm.quantity);
        body.quoted_price = Number(markForm.quoted_price);
      } else if (markForm.method === 'last_round') {
        body.quantity = Number(markForm.quantity);
        body.round_price_per_share = Number(markForm.round_price_per_share);
      } else if (markForm.method === 'calibrated_opm') {
        body.model_value = Number(markForm.model_value);
      }
      await api(`/funds/${fundId}/positions/${position.id}/marks`, { method: 'POST', body });
      await loadMarks();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record mark');
    } finally {
      setRecording(false);
    }
  });

  const lm = position.latest_mark;
  return (
    <div className="rounded-md border border-paper-200">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="touch:min-h-11 flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-paper-50"
      >
        <span className="font-medium text-ink-700">
          {position.company_name}
          <span className="ml-2 text-xs text-ink-400">{position.security_type}</span>
        </span>
        <span className="tnum text-ink-600">
          {lm
            ? `${money(Number(lm.fair_value), currency)} · L${lm.level}`
            : `cost ${money(Number(position.cost_basis), currency)}`}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-paper-200 p-3">
          {error && <ErrorNote>{error}</ErrorNote>}
          <form onSubmit={addMark} className="grid grid-cols-2 gap-2 md:grid-cols-4" noValidate>
            <Field
              label="Date"
              tooltip="Measurement date for this mark. For a calibrated OPM, this is the calibration date the model is anchored to — usually the last observable transaction, such as the round the fund invested in."
              error={mark.errorFor('measurement_date')}
            >
              <TextInput
                value={markForm.measurement_date}
                onChange={(e) => setMarkForm({ ...markForm, measurement_date: e.target.value })}
                onBlur={mark.blurHandler('measurement_date')}
              />
            </Field>
            <Field label="Method">
              <Select
                value={markForm.method}
                onChange={(e) => setMarkForm({ ...markForm, method: e.target.value })}
              >
                <option value="market">Market (L1)</option>
                <option value="last_round">Last round (L2)</option>
                <option value="calibrated_opm">Calibrated (L3)</option>
                <option value="cost">Cost (L3)</option>
              </Select>
            </Field>
            {markForm.method === 'market' && (
              <Field label="Quoted price" error={mark.errorFor('quoted_price')}>
                <TextInput
                  value={markForm.quoted_price}
                  onChange={(e) => setMarkForm({ ...markForm, quoted_price: e.target.value })}
                  onBlur={mark.blurHandler('quoted_price')}
                />
              </Field>
            )}
            {markForm.method === 'last_round' && (
              <Field label="Round price/sh" error={mark.errorFor('round_price_per_share')}>
                <TextInput
                  value={markForm.round_price_per_share}
                  onChange={(e) => setMarkForm({ ...markForm, round_price_per_share: e.target.value })}
                  onBlur={mark.blurHandler('round_price_per_share')}
                />
              </Field>
            )}
            {markForm.method === 'calibrated_opm' && (
              <Field label="Model value" error={mark.errorFor('model_value')}>
                <TextInput
                  value={markForm.model_value}
                  onChange={(e) => setMarkForm({ ...markForm, model_value: e.target.value })}
                  onBlur={mark.blurHandler('model_value')}
                />
              </Field>
            )}
            <div className="flex items-end">
              <Button type="submit" variant="secondary" disabled={recording}>
                {recording ? 'Recording…' : 'Record mark'}
              </Button>
            </div>
          </form>
          <div>
            <h3 id="mark-history-heading" className="overline mb-1 text-ink-400">
              Mark history
            </h3>
            {!marks ? (
              <Spinner />
            ) : marks.length === 0 ? (
              <p className="text-xs text-ink-400">No marks yet.</p>
            ) : (
              <table className="w-full text-xs" aria-labelledby="mark-history-heading">
                <thead>
                  <tr className="border-b border-paper-200 text-left text-ink-500">
                    <th className="py-1">Date</th>
                    <th className="py-1">Method</th>
                    <th className="py-1">Level</th>
                    <th className="py-1">Fair value</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {marks.map((m) => (
                    <tr key={m.id} className="border-b border-paper-100 last:border-0">
                      <td className="py-1">{m.measurement_date}</td>
                      <td className="py-1">{m.method}</td>
                      <td className="py-1">L{m.level}</td>
                      <td className="py-1">{money(Number(m.fair_value), currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <ListTruncationNote truncated={marksCapped} shown={marks?.length ?? 0} noun="marks" />
          </div>
          {/*
           * Removing a holding is not refused for a linked fund, unlike deleting
           * the portfolio: a position entered against the wrong fund is the
           * ordinary correction this exists for, and refusing it would leave a
           * linked engagement's NAV permanently wrong with no way to fix it.
           */}
          <div>
            <Button
              variant="ghost"
              className="!px-3 !py-1.5 !text-xs"
              disabled={removing}
              onClick={() => {
                if (!window.confirm(`Remove “${position.company_name}” and its marks?`)) return;
                setRemoving(true);
                setError(null);
                void api(`/funds/${fundId}/positions/${position.id}`, { method: 'DELETE' })
                  .then(() => onChange())
                  .catch((e: unknown) => {
                    setError(e instanceof ApiError ? e.message : 'Could not remove the holding');
                    setRemoving(false);
                  });
              }}
            >
              Remove holding
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function WaterfallCard({
  fundId,
  lpTerms,
  currency,
  onSaved,
}: {
  fundId: string;
  lpTerms: LpTerms | null;
  currency: string;
  onSaved: () => void;
}) {
  const [terms, setTerms] = useState({
    committed_capital: lpTerms?.committed_capital ?? '0',
    contributed_capital: lpTerms?.contributed_capital ?? '0',
    preferred_return_rate: lpTerms?.preferred_return_rate ?? '0.08',
    carry_pct: lpTerms?.carry_pct ?? '0.2',
    gp_catch_up: lpTerms?.gp_catch_up ?? true,
  });
  const [distributable, setDistributable] = useState('0');
  const [years, setYears] = useState('1');
  const [result, setResult] = useState<Waterfall | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * `save` or `run`, whichever is in flight. Both write, both reload, and
   * "Run waterfall" in particular takes long enough on a fund with real
   * positions that a silent button is read as a dead one.
   */
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);

  const save = async () => {
    if (busy) return;
    setBusy('save');
    setError(null);
    try {
      await api(`/funds/${fundId}/lp-terms`, {
        method: 'PUT',
        body: {
          committed_capital: Number(terms.committed_capital),
          contributed_capital: Number(terms.contributed_capital),
          preferred_return_rate: Number(terms.preferred_return_rate),
          carry_pct: Number(terms.carry_pct),
          gp_catch_up: terms.gp_catch_up,
        },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save LP terms');
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (busy) return;
    setBusy('run');
    setError(null);
    try {
      const { waterfall } = await api<{ waterfall: Waterfall }>(`/funds/${fundId}/waterfall`, {
        method: 'POST',
        body: { distributable: Number(distributable), years: Number(years) },
      });
      setResult(waterfall);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to run waterfall');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-paper-200 bg-surface p-4">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-700">
        LP waterfall calculator
        <InfoTooltip
          label="About the LP waterfall"
          text="Distributes proceeds through the standard tiers, in order: return of capital to LPs, the preferred return (hurdle), an optional GP catch-up, then the carry split. Any GP overpayment across the fund’s life shows as a clawback."
        />
      </h2>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Committed">
          <TextInput
            value={terms.committed_capital}
            onChange={(e) => setTerms({ ...terms, committed_capital: e.target.value })}
          />
        </Field>
        <Field label="Contributed">
          <TextInput
            value={terms.contributed_capital}
            onChange={(e) => setTerms({ ...terms, contributed_capital: e.target.value })}
          />
        </Field>
        <Field
          label="Pref return"
          tooltip="The LP hurdle rate (e.g. 0.08 = 8%). LPs earn this preferred return on contributed capital before the GP shares in profits."
        >
          <TextInput
            value={terms.preferred_return_rate}
            onChange={(e) => setTerms({ ...terms, preferred_return_rate: e.target.value })}
          />
        </Field>
        <Field
          label="Carry"
          tooltip="The GP’s carried-interest percentage — its share of profits above the hurdle (e.g. 0.20 = 20%, the ‘20’ in a 20% carry / 80% LP split)."
        >
          <TextInput
            value={terms.carry_pct}
            onChange={(e) => setTerms({ ...terms, carry_pct: e.target.value })}
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm text-ink-600">
          <input
            type="checkbox"
            checked={terms.gp_catch_up}
            onChange={(e) => setTerms({ ...terms, gp_catch_up: e.target.checked })}
          />{' '}
          GP catch-up
        </label>
        <Button variant="secondary" onClick={() => void save()} disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Save LP terms'}
        </Button>
        <Field label="Distributable">
          <TextInput value={distributable} onChange={(e) => setDistributable(e.target.value)} />
        </Field>
        <Field label="Years">
          <TextInput value={years} onChange={(e) => setYears(e.target.value)} className="w-16" />
        </Field>
        <Button onClick={() => void run()} disabled={busy !== null}>
          {busy === 'run' ? 'Running…' : 'Run waterfall'}
        </Button>
      </div>
      {result && (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
          <SummaryCard label="To LPs" value={money(result.lp_distribution, currency)} accent />
          <SummaryCard label="To GP (carry)" value={money(result.gp_distribution, currency)} />
          <SummaryCard label="Clawback owed" value={money(result.clawback_owed, currency)} />
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={`rounded-lg border p-3 ${accent ? 'border-bond-200 bg-bond-50' : 'border-paper-200 bg-surface'}`}
    >
      <div className="overline text-ink-400">{label}</div>
      <div className={`tnum mt-1 text-lg font-semibold ${accent ? 'text-bond-700' : 'text-ink-800'}`}>
        {value}
      </div>
    </div>
  );
}
