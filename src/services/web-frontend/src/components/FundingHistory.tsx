import { useCallback, useEffect, useState } from 'react';
import { all, integer, numberMin, optional, required, useFormValidation } from '../lib/useFormValidation';
import { api, describeActionFailure } from '../lib/api';
import { formatDate, formatCents, formatNumber } from '../lib/format';
import { TRANSACTION_KINDS } from '../lib/types';
import type { FundingRound, ValuationTransaction } from '../lib/types';
import { Button, ErrorNote, Field, ListTruncationNote, Select, TextInput } from './ui';

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
  /**
   * Whether each book ran past its page. Both are ordered oldest-first — a
   * financing history that starts in the middle is not a financing history —
   * so what a truncated list is missing is the recent end.
   */
  const [truncated, setTruncated] = useState({ rounds: false, transactions: false });
  const [busy, setBusy] = useState(false);
  const [addingRound, setAddingRound] = useState(false);
  const [addingTxn, setAddingTxn] = useState(false);
  const [roundForm, setRoundForm] = useState({
    name: '',
    security_type: '',
    closed_on: '',
    amount: '',
    pre_money: '',
    post_money: '',
  });
  const [txnForm, setTxnForm] = useState({
    kind: 'issuance',
    occurred_on: '',
    shares: '',
    price: '',
    counterparty: '',
  });

  const load = useCallback(async () => {
    try {
      const [r, t] = await Promise.all([
        api<{ rounds: FundingRound[]; truncated: boolean }>(`/valuations/${valuationId}/rounds`),
        api<{ transactions: ValuationTransaction[]; truncated: boolean }>(
          `/valuations/${valuationId}/transactions`,
        ),
      ]);
      setRounds(r.rounds);
      setTransactions(t.transactions);
      setTruncated({ rounds: r.truncated, transactions: t.truncated });
    } catch {
      setError('Could not load funding history.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The operation is the caller's to name, because this wrapper serves four of
   * them and two are removals.
   *
   * It answered all four with "Could not save.", which is vague for the two
   * adds and simply untrue for the two removes: nothing was being saved, and a
   * reader told a save failed goes back to the form they had just filled in
   * rather than to the row that is still there. `describeActionFailure`
   * concatenates this with the server's own sentence, so the cost of the
   * shared wrapper was the whole first half of every message.
   */
  const run = async (operation: string, fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(describeActionFailure(err, operation));
    } finally {
      setBusy(false);
    }
  };

  /*
   * The money boxes are genuinely optional — a round can be recorded before its
   * terms are — but each carries `min="0"`, and `toCents` will happily turn
   * "-5" into a negative cent figure the API stores without complaint. So the
   * floor applies only once something has been typed.
   */
  const roundValidation = useFormValidation(roundForm, {
    name: required('name', 'Round name'),
    amount: optional('amount', numberMin('amount', 0, 'Amount raised')),
    pre_money: optional('pre_money', numberMin('pre_money', 0, 'Pre-money')),
    post_money: optional('post_money', numberMin('post_money', 0, 'Post-money')),
  });

  const txnValidation = useFormValidation(txnForm, {
    occurred_on: required('occurred_on', 'Date'),
    shares: optional('shares', all(numberMin('shares', 0, 'Shares'), integer('shares', 'Shares'))),
    price: optional('price', numberMin('price', 0, 'Price / share')),
  });

  const addRound = roundValidation.handleSubmit(() =>
    run('Could not add that funding round.', async () => {
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
      // The panel stays mounted, so the next round starts with a clean slate
      // rather than every message revealed from the last submit.
      roundValidation.reset();
    }),
  );

  const addTxn = txnValidation.handleSubmit(() =>
    run('Could not add that secondary transaction.', async () => {
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
      txnValidation.reset();
    }),
  );

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h2 className="overline mb-5 text-ink-400">Funding & transaction history</h2>
      {error && (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 id="funding-rounds-heading" className="text-sm font-semibold text-ink-800">
          Funding rounds
        </h3>
        {canEdit && (
          <Button variant="ghost" onClick={() => setAddingRound((v) => !v)}>
            {addingRound ? 'Cancel' : '+ Add round'}
          </Button>
        )}
      </div>
      {addingRound && (
        <form
          onSubmit={addRound}
          className="mt-3 grid gap-4 rounded-md border border-paper-300 bg-paper-50 p-4 sm:grid-cols-3"
          noValidate
        >
          <Field label="Round name" error={roundValidation.errorFor('name')}>
            <TextInput
              value={roundForm.name}
              onChange={(e) => setRoundForm((f) => ({ ...f, name: e.target.value }))}
              onBlur={roundValidation.blurHandler('name')}
              required
              placeholder="Series A"
            />
          </Field>
          <Field label="Security type">
            <TextInput
              value={roundForm.security_type}
              onChange={(e) => setRoundForm((f) => ({ ...f, security_type: e.target.value }))}
              placeholder="Preferred"
            />
          </Field>
          <Field label="Closed on">
            <TextInput
              type="date"
              value={roundForm.closed_on}
              onChange={(e) => setRoundForm((f) => ({ ...f, closed_on: e.target.value }))}
            />
          </Field>
          <Field label="Amount raised ($)" error={roundValidation.errorFor('amount')}>
            <TextInput
              type="number"
              min="0"
              step="any"
              value={roundForm.amount}
              onChange={(e) => setRoundForm((f) => ({ ...f, amount: e.target.value }))}
              onBlur={roundValidation.blurHandler('amount')}
            />
          </Field>
          <Field label="Pre-money ($)" error={roundValidation.errorFor('pre_money')}>
            <TextInput
              type="number"
              min="0"
              step="any"
              value={roundForm.pre_money}
              onChange={(e) => setRoundForm((f) => ({ ...f, pre_money: e.target.value }))}
              onBlur={roundValidation.blurHandler('pre_money')}
            />
          </Field>
          <Field label="Post-money ($)" error={roundValidation.errorFor('post_money')}>
            <TextInput
              type="number"
              min="0"
              step="any"
              value={roundForm.post_money}
              onChange={(e) => setRoundForm((f) => ({ ...f, post_money: e.target.value }))}
              onBlur={roundValidation.blurHandler('post_money')}
            />
          </Field>
          <div className="sm:col-span-3">
            {/* Enabled while incomplete — a disabled button cannot say why. */}
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Add round'}
            </Button>
          </div>
        </form>
      )}
      {rounds && rounds.length === 0 && (
        <p className="mt-2 text-sm text-ink-400">No funding rounds recorded.</p>
      )}
      {rounds && rounds.length > 0 && (
        <div className="mt-3 overflow-x-auto overscroll-x-contain">
          <table className="w-full min-w-[560px] text-sm" aria-labelledby="funding-rounds-heading">
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
                  <td className="tnum py-2.5 pr-4 text-right text-ink-900">
                    {formatCents(r.amount_raised_cents, currency)}
                  </td>
                  <td className="tnum py-2.5 pr-4 text-right text-ink-600">
                    {formatCents(r.pre_money_cents, currency)}
                  </td>
                  <td className="tnum py-2.5 pr-4 text-right text-ink-600">
                    {formatCents(r.post_money_cents, currency)}
                  </td>
                  {canEdit && (
                    <td className="py-2.5 text-right">
                      <button
                        onClick={() =>
                          void run('Could not remove that funding round.', () =>
                            api(`/valuations/${valuationId}/rounds/${r.id}`, { method: 'DELETE' }),
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
      <ListTruncationNote
        truncated={truncated.rounds}
        shown={rounds?.length ?? 0}
        noun="financing rounds"
        hint="the most recent rounds are not listed"
      />

      <div className="mt-7 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-800">Share transactions</h3>
        {canEdit && (
          <Button variant="ghost" onClick={() => setAddingTxn((v) => !v)}>
            {addingTxn ? 'Cancel' : '+ Add transaction'}
          </Button>
        )}
      </div>
      {addingTxn && (
        <form
          onSubmit={addTxn}
          className="mt-3 grid gap-4 rounded-md border border-paper-300 bg-paper-50 p-4 sm:grid-cols-3"
          noValidate
        >
          <Field label="Type">
            <Select
              value={txnForm.kind}
              onChange={(e) => setTxnForm((f) => ({ ...f, kind: e.target.value }))}
            >
              {TRANSACTION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TXN_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date" error={txnValidation.errorFor('occurred_on')}>
            <TextInput
              type="date"
              value={txnForm.occurred_on}
              onChange={(e) => setTxnForm((f) => ({ ...f, occurred_on: e.target.value }))}
              onBlur={txnValidation.blurHandler('occurred_on')}
              required
            />
          </Field>
          <Field label="Counterparty">
            <TextInput
              value={txnForm.counterparty}
              onChange={(e) => setTxnForm((f) => ({ ...f, counterparty: e.target.value }))}
            />
          </Field>
          <Field label="Shares" error={txnValidation.errorFor('shares')}>
            <TextInput
              type="number"
              min="0"
              step="1"
              value={txnForm.shares}
              onChange={(e) => setTxnForm((f) => ({ ...f, shares: e.target.value }))}
              onBlur={txnValidation.blurHandler('shares')}
            />
          </Field>
          <Field label="Price / share ($)" error={txnValidation.errorFor('price')}>
            <TextInput
              type="number"
              min="0"
              step="any"
              value={txnForm.price}
              onChange={(e) => setTxnForm((f) => ({ ...f, price: e.target.value }))}
              onBlur={txnValidation.blurHandler('price')}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Add transaction'}
            </Button>
          </div>
        </form>
      )}
      {transactions && transactions.length === 0 && (
        <p className="mt-2 text-sm text-ink-400">No transactions recorded.</p>
      )}
      {transactions && transactions.length > 0 && (
        <div className="mt-3 overflow-x-auto overscroll-x-contain">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">Secondary transactions</caption>
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
                  <td className="tnum py-2.5 pr-4 text-right text-ink-600">
                    {formatCents(t.price_per_share_cents, currency)}
                  </td>
                  <td className="py-2.5 pr-4 text-ink-600">{t.counterparty ?? '—'}</td>
                  {canEdit && (
                    <td className="py-2.5 text-right">
                      <button
                        onClick={() =>
                          void run('Could not remove that secondary transaction.', () =>
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
      <ListTruncationNote
        truncated={truncated.transactions}
        shown={transactions?.length ?? 0}
        noun="transactions"
        hint="the most recent trades are not listed"
      />
    </section>
  );
}
