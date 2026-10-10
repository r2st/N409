import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, describeLoadFailure, describeRequestFailure } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PRICING_TIERS, formatUsd, type PricingTier } from '../lib/marketing';
import { formatChargedCents, formatDate } from '../lib/format';
import { Button, ErrorNote, LoadError, Spinner } from '../components/ui';

type Step = 'plan' | 'details' | 'confirm';

interface OrderHistoryItem {
  id: string;
  tier: string;
  plan_name: string;
  amount_cents: number;
  currency: string;
  status: 'pending' | 'active' | 'completed' | 'canceled';
  company_name: string;
  created_at: string;
  stripe_checkout_url?: string;
}

function PlanSelector({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (tier: string) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3" data-testid="plan-selector">
      {PRICING_TIERS.map((tier) => (
        <button
          key={tier.tier}
          type="button"
          onClick={() => onSelect(tier.tier)}
          className={`rounded-lg border p-5 text-left transition-colors ${
            selected === tier.tier
              ? 'border-bond-600 bg-bond-50 ring-2 ring-bond-600/20'
              : 'border-paper-300 bg-surface hover:border-ink-200'
          }`}
          data-testid={`select-${tier.tier}`}
        >
          <div className="font-display text-lg font-semibold text-ink-900">{tier.name}</div>
          <div className="mt-1">
            <span className="tnum font-display text-2xl font-semibold text-ink-900">
              {formatUsd(tier.priceCents)}
            </span>
            <span className="ml-1 text-sm text-ink-500">
              {tier.interval === 'one_time' ? '/valuation' : '/month'}
            </span>
          </div>
          <p className="mt-2 text-xs text-ink-500">{tier.tagline}</p>
        </button>
      ))}
    </div>
  );
}

function CompanyDetailsForm({
  companyName,
  setCompanyName,
  companyUrl,
  setCompanyUrl,
  onBack,
  onNext,
}: {
  companyName: string;
  setCompanyName: (v: string) => void;
  companyUrl: string;
  setCompanyUrl: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="mx-auto max-w-lg" data-testid="company-details">
      <h2 className="font-display text-xl font-semibold text-ink-900">Company details</h2>
      <p className="mt-1 text-sm text-ink-500">
        Tell us about the company this valuation is for.
      </p>
      <div className="mt-6 space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-ink-700">Company name</span>
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Acme Corp"
            className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 focus:border-bond-600 focus:outline-none"
            data-testid="company-name-input"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-ink-700">
            Company website <span className="font-normal text-ink-400">(optional)</span>
          </span>
          <input
            type="url"
            value={companyUrl}
            onChange={(e) => setCompanyUrl(e.target.value)}
            placeholder="https://acme.com"
            className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 focus:border-bond-600 focus:outline-none"
            data-testid="company-url-input"
          />
        </label>
      </div>
      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="text-sm font-semibold text-ink-500 hover:text-ink-700"
        >
          Back
        </button>
        <Button disabled={!companyName.trim()} onClick={onNext} data-testid="continue-to-confirm">
          Continue
        </Button>
      </div>
    </div>
  );
}

function ConfirmStep({
  tier,
  companyName,
  companyUrl,
  onBack,
  onCheckout,
  busy,
  error,
}: {
  tier: PricingTier;
  companyName: string;
  companyUrl: string;
  onBack: () => void;
  onCheckout: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <div className="mx-auto max-w-lg" data-testid="order-confirm">
      <h2 className="font-display text-xl font-semibold text-ink-900">Confirm your order</h2>
      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="mt-6 rounded-lg border border-paper-300 bg-paper-50 p-5">
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-500">Plan</dt>
            <dd className="font-semibold text-ink-900">{tier.name}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Price</dt>
            <dd className="tnum font-semibold text-ink-900">
              {formatUsd(tier.priceCents)}
              {tier.interval === 'month' ? '/month' : ''}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Company</dt>
            <dd className="font-semibold text-ink-900">{companyName}</dd>
          </div>
          {companyUrl && (
            <div className="flex justify-between">
              <dt className="text-ink-500">Website</dt>
              <dd className="text-ink-900">{companyUrl}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-ink-500">Valuations</dt>
            <dd className="font-semibold text-ink-900">
              {tier.valuationLimit !== null
                ? `${tier.valuationLimit} ${tier.interval === 'one_time' ? 'report' : 'per year'}`
                : 'Unlimited'}
            </dd>
          </div>
        </dl>
      </div>
      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="text-sm font-semibold text-ink-500 hover:text-ink-700"
        >
          Back
        </button>
        <Button disabled={busy} onClick={onCheckout} data-testid="proceed-to-payment">
          {busy ? 'Opening checkout...' : `Pay ${formatUsd(tier.priceCents)} now`}
        </Button>
      </div>
    </div>
  );
}

function OrderHistory() {
  const [orders, setOrders] = useState<OrderHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    api<{ orders: OrderHistoryItem[] }>('/me/orders')
      .then((d) => setOrders(d.orders))
      .catch((err: unknown) => setError(describeLoadFailure(err, 'Could not load order history.')));
  }, [retryToken]);

  if (error) {
    return (
      <section className="mt-10" data-testid="order-history">
        <h2 className="overline mb-3 text-ink-400">Order history</h2>
        <LoadError message={error} onRetry={() => { setError(null); setRetryToken((n) => n + 1); }} />
      </section>
    );
  }
  if (!orders || orders.length === 0) return null;

  const STATUS_TONES: Record<string, string> = {
    active: 'bg-bond-50 text-bond-700',
    completed: 'bg-bond-50 text-bond-700',
    pending: 'bg-amber-50 text-amber-800',
    canceled: 'bg-paper-200 text-ink-500',
  };

  return (
    <section className="mt-10" data-testid="order-history">
      <h2 className="overline mb-3 text-ink-400">Order history</h2>
      <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
        <table className="w-full min-w-[580px] text-sm" aria-label="Order history">
          <thead>
            <tr className="border-b border-paper-300 text-left">
              <th className="overline px-5 py-3 font-semibold text-ink-400">Date</th>
              <th className="overline px-5 py-3 font-semibold text-ink-400">Plan</th>
              <th className="overline px-5 py-3 font-semibold text-ink-400">Company</th>
              <th className="overline px-5 py-3 font-semibold text-ink-400">Amount</th>
              <th className="overline px-5 py-3 font-semibold text-ink-400">Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-b border-paper-200 last:border-0">
                <td className="tnum px-5 py-3.5 text-ink-600">{formatDate(o.created_at)}</td>
                <td className="px-5 py-3.5 font-semibold text-ink-800">{o.plan_name}</td>
                <td className="px-5 py-3.5 text-ink-700">{o.company_name}</td>
                <td className="tnum px-5 py-3.5 font-semibold text-ink-800">
                  {formatChargedCents(o.amount_cents, o.currency)}
                </td>
                <td className="px-5 py-3.5">
                  <span
                    className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      STATUS_TONES[o.status] ?? STATUS_TONES.pending
                    }`}
                  >
                    {o.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function OrderPage() {
  const { status } = useAuth();
  const [params] = useSearchParams();
  const initialTier = params.get('tier');

  const [step, setStep] = useState<Step>(initialTier ? 'details' : 'plan');
  const [selectedTier, setSelectedTier] = useState<string | null>(initialTier);
  const [companyName, setCompanyName] = useState('');
  const [companyUrl, setCompanyUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tier = PRICING_TIERS.find((t) => t.tier === selectedTier);

  if (status === 'loading') return <Spinner />;
  if (status === 'anonymous') {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <h1 className="font-display text-2xl font-semibold text-ink-900">Sign in to continue</h1>
        <p className="mt-2 text-sm text-ink-500">
          You need an account to place an order.
        </p>
        <Link
          to={`/register?redirect=/order${initialTier ? `?tier=${initialTier}` : ''}`}
          className="mt-6 inline-block rounded-md bg-bond-600 px-6 py-2.5 text-sm font-semibold text-bond-fg shadow-card hover:bg-bond-700"
        >
          Create an account
        </Link>
      </div>
    );
  }

  const handleSelectPlan = (t: string) => {
    setSelectedTier(t);
    setStep('details');
  };

  const handleCheckout = async () => {
    if (!tier) return;
    setError(null);
    setBusy(true);
    try {
      const { checkout_url } = await api<{ checkout_url: string }>('/orders/checkout', {
        method: 'POST',
        body: {
          tier: tier.tier,
          company_name: companyName.trim(),
          company_url: companyUrl.trim() || null,
        },
      });
      window.location.assign(checkout_url);
    } catch (err) {
      setError(
        err instanceof ApiError && err.problem.type === 'urn:n409:problem:payments-unconfigured'
          ? 'Online payment is not available yet — we will invoice you instead.'
          : describeRequestFailure(err),
      );
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="overline text-ink-400">Order</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">
        {step === 'plan' && 'Choose a plan'}
        {step === 'details' && (tier?.name ?? 'Order')}
        {step === 'confirm' && 'Review & pay'}
      </h1>

      {/* Step indicator */}
      <div className="mt-6 flex items-center gap-2 text-xs text-ink-400" data-testid="order-steps">
        {(['plan', 'details', 'confirm'] as const).map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            {i > 0 && <span className="text-ink-300">→</span>}
            <span
              className={`rounded-full px-2.5 py-0.5 font-semibold ${
                s === step ? 'bg-bond-600 text-bond-fg' : 'bg-paper-200 text-ink-500'
              }`}
            >
              {s === 'plan' ? 'Plan' : s === 'details' ? 'Details' : 'Payment'}
            </span>
          </span>
        ))}
      </div>

      <div className="mt-8">
        {step === 'plan' && <PlanSelector selected={selectedTier} onSelect={handleSelectPlan} />}
        {step === 'details' && (
          <CompanyDetailsForm
            companyName={companyName}
            setCompanyName={setCompanyName}
            companyUrl={companyUrl}
            setCompanyUrl={setCompanyUrl}
            onBack={() => setStep('plan')}
            onNext={() => setStep('confirm')}
          />
        )}
        {step === 'confirm' && tier && (
          <ConfirmStep
            tier={tier}
            companyName={companyName}
            companyUrl={companyUrl}
            onBack={() => setStep('details')}
            onCheckout={() => void handleCheckout()}
            busy={busy}
            error={error}
          />
        )}
      </div>

      <OrderHistory />
    </div>
  );
}
