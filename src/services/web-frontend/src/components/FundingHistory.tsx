import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { formatDate, formatMoney, formatNumber } from '../lib/format';
import { TRANSACTION_KINDS } from '../lib/types';
import type { FundingRound, ValuationTransaction } from '../lib/types';
import { Button, ErrorNote, Field, Select, TextInput } from './ui';

/** Transaction & funding-round history per valuation (M4). */

const TXN_LABELS: Record<string, string> = {
  issuance: 'Issuance',
  secondary_sale: 'Secondary sale',
  repurchase: 'Repurchase',
  conversion: 'Conversion',
  transfer: 'Transfer',
  other: 'Other',
};

const toCents = (dollars: string): number | null =>
  dollars.trim() === '' ? null : Math.round(Number(dollars) * 100);

export function FundingHistory({
  valuationId,
  currency,
  canEdit,
}: {
  valuationId: string;
  currency: string | null;
  canEdit: boolean;
}) {
  const [rounds, setRounds] = useState<FundingRound[] | null>(null);
  const [transactions, setTransactions] = useState<ValuationTransaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingRound, setAddingRound] = useState(false);
  const [addingTxn, setAddingTxn] = useState(false);
  const [roundForm, setRoundForm] = useState({ name: '', security_type: '', closed_on: '', amount: '', pre_money: '', post_money: '' });
  const [txnForm, setTxnForm] = useState({ kind: 'issuance', occurred_on: '', shares: '', price: '', counterparty: '' });

  const load = useCallback(async () => {
    try {
      const [r, t] = await Promise.all([
        api<{ rounds: FundingRound[] }>(`/valuations/${valuationId}/rounds`),
        api<{ transactions: ValuationTransaction[] }>(`/valuations/${valuationId}/transactions`),
      ]);
      setRounds(r.rounds);
      setTransactions(t.transactions);
    } catch {
      setError('Could not load funding history.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const addRound = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(`/valuations/${valuationId}/rounds`, {
        method: 'POST',
        body: {
          name: roundForm.name.trim(),
          security_type: roundForm.security_type.trim() || null,
          closed_on: roundForm.closed_on || null,
          amount_raised_cents: toCents(roundForm.amount),
          pre_money_cents: toCents(roundForm.pre_money),
          post_money_cents: toCents(roundForm.post_money),
        },
      });
      setAddingRound(false);
      setRoundForm({ name: '', security_type: '', closed_on: '', amount: '', pre_money: '', post_money: '' });
    });
  };

  const addTxn = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(`/valuations/${valuationId}/transactions`, {
        method: 'POST',
        body: {
          kind: txnForm.kind,
          occurred_on: txnForm.occurred_on,
          shares: txnForm.shares.trim() === '' ? null : Math.round(Number(txnForm.shares)),
          price_per_share_cents: toCents(txnForm.price),
          counterparty: txnForm.counterparty.trim() || null,
        },
      });
      setAddingTxn(false);
      setTxnForm({ kind: 'issuance', occurred_on: '', shares: '', price: '', counterparty: '' });
    });
  };

  return (
    <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
      <h2 className="overline mb-5 text-ink-400">Funding & transaction history</h2>
      {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-800">Funding rounds</h3>
        {canEdit && (
          <Button variant="ghost" onClick={() => setAddingRound((v) => !v)}>
            {addingRound ? 'Cancel' : '+ Add round'}
          </Button>
        )}
      </div>
      {addingRound && (
        <form onSubmit={addRound} className="mt-3 grid gap-4 rounded-md border border-paper-300 bg-paper-50 p-4 sm:grid-cols-3">
          <Field label="Round name">
            <TextInput value={roundForm.name} onChange={(e) => setRoundForm((f) => ({ ...f, name: e.target.value }))} required placeholder="Series A" />
          </Field>
          <Field label="Security type">
            <TextInput value={roundForm.security_type} onChange={(e) => setRoundForm((f) => ({ ...f, security_type: e.target.value }))} placeholder="Preferred" />
          </Field>
          <Field label="Closed on">
            <TextInput type="date" value={roundForm.closed_on} onChange={(e) => setRoundForm((f) => ({ ...f, closed_on: e.target.value }))} />
          </Field>
          <Field label="Amount raised ($)">
            <TextInput type="number" min="0" step="any" value={roundForm.amount} onChange={(e) => setRoundForm((f) => ({ ...f, amount: e.target.value }))} />
          </Field>
          <Field label="Pre-money ($)">
            <TextInput type="number" min="0" step="any" value={roundForm.pre_money} onChange={(e) => setRoundForm((f) => ({ ...f, pre_money: e.target.value }))} />
          </Field>
          <Field label="Post-money ($)">
            <TextInput type="number" min="0" step="any" value={roundForm.post_money} onChange={(e) => setRoundForm((f) => ({ ...f, post_money: e.target.value }))} />
          </Field>
          <div className="sm:col-span-3">
            <Button type="submit" disabled={busy || !roundForm.name.trim()}>
              {busy ? 'Saving…' : 'Add round'}
            </Button>
          </div>
        </form>
      )}
      {rounds && rounds.length === 0 && <p className="mt-2 text-sm text-ink-400">No funding rounds recorded.</p>}
      {rounds && rounds.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline py-2 pr-4 font-semibold text-ink-400">Round</th>
                <th className="overline py-2 pr-4 font-semibold text-ink-400">Closed</th>
                <th className="overline py-2 pr-4 text-right font-semibold text-ink-400">Raised</th>
                <th className="overline py-2 pr-4 text-right font-semibold text-ink-400">Pre</th>
                <th className="overline py-2 pr-4 text-right font-semibold text-ink-400">Post</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {rounds.map((r) => (
                <tr key={r.id} className="border-b border-paper-200 last:border-0">
                  <td className="py-2.5 pr-4">
                    <span className="font-semibold text-ink-900">{r.name}</span>
                    {r.security_type && <span className="ml-2 text-xs text-ink-400">{r.security_type}</span>}
                  </td>
                  <td className="tnum py-2.5 pr-4 text-ink-600">{formatDate(r.closed_on)}</td>
                  <td className="tnum py-2.5 pr-4 text-right text-ink-900">{formatMoney(r.amount_raised_cents, currency)}</td>
                  <td className="tnum py-2.5 pr-4 text-right text-ink-600">{formatMoney(r.pre_money_cents, currency)}</td>
                  <td className="tnum py-2.5 pr-4 text-right text-ink-600">{formatMoney(r.post_money_cents, currency)}</td>
                  {canEdit && (
                    <td className="py-2.5 text-right">
                      <button
                        onClick={() =>
                          void run(() => api(`/valuations/${valuationId}/rounds/${r.id}`, { method: 'DELETE' }))
                        }
                        className="cursor-pointer text-xs font-semibold text-red-600 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-7 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-800">Share transactions</h3>
        {canEdit && (
          <Button variant="ghost" onClick={() => setAddingTxn((v) => !v)}>
            {addingTxn ? 'Cancel' : '+ Add transaction'}
          </Button>
        )}
      </div>
      {addingTxn && (
        <form onSubmit={addTxn} className="mt-3 grid gap-4 rounded-md border border-paper-300 bg-paper-50 p-4 sm:grid-cols-3">
          <Field label="Type">
            <Select value={txnForm.kind} onChange={(e) => setTxnForm((f) => ({ ...f, kind: e.target.value }))}>
              {TRANSACTION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TXN_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <TextInput type="date" value={txnForm.occurred_on} onChange={(e) => setTxnForm((f) => ({ ...f, occurred_on: e.target.value }))} required />
          </Field>
          <Field label="Counterparty">
            <TextInput value={txnForm.counterparty} onChange={(e) => setTxnForm((f) => ({ ...f, counterparty: e.target.value }))} />
          </Field>
          <Field label="Shares">
            <TextInput type="number" min="0" step="1" value={txnForm.shares} onChange={(e) => setTxnForm((f) => ({ ...f, shares: e.target.value }))} />
          </Field>
          <Field label="Price / share ($)">
            <TextInput type="number" min="0" step="any" value={txnForm.price} onChange={(e) => setTxnForm((f) => ({ ...f, price: e.target.value }))} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy || !txnForm.occurred_on}>
              {busy ? 'Saving…' : 'Add transaction'}
            </Button>
          </div>
        </form>
      )}
      {transactions && transactions.length === 0 && (
        <p className="mt-2 text-sm text-ink-400">No transactions recorded.</p>
      )}
      {transactions && transactions.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline py-2 pr-4 font-semibold text-ink-400">Type</th>
                <th className="overline py-2 pr-4 font-semibold text-ink-400">Date</th>
                <th className="overline py-2 pr-4 text-right font-semibold text-ink-400">Shares</th>
                <th className="overline py-2 pr-4 text-right font-semibold text-ink-400">Price</th>
                <th className="overline py-2 pr-4 font-semibold text-ink-400">Counterparty</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id} className="border-b border-paper-200 last:border-0">
                  <td className="py-2.5 pr-4 font-semibold text-ink-900">{TXN_LABELS[t.kind]}</td>
                  <td className="tnum py-2.5 pr-4 text-ink-600">{formatDate(t.occurred_on)}</td>
                  <td className="tnum py-2.5 pr-4 text-right text-ink-600">{formatNumber(t.shares)}</td>
                  <td className="tnum py-2.5 pr-4 text-right text-ink-600">{formatMoney(t.price_per_share_cents, currency)}</td>
                  <td className="py-2.5 pr-4 text-ink-600">{t.counterparty ?? '—'}</td>
                  {canEdit && (
                    <td className="py-2.5 text-right">
                      <button
                        onClick={() =>
                          void run(() =>
                            api(`/valuations/${valuationId}/transactions/${t.id}`, { method: 'DELETE' }),
                          )
                        }
                        className="cursor-pointer text-xs font-semibold text-red-600 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
