import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';
import { ShareResultBar } from '../../components/ShareResultBar';

type OptionType = 'iso' | 'nso';

interface TaxResult {
  optionType: OptionType;
  shares: number;
  strikePrice: number;
  fmv: number;
  spread: number;
  totalSpread: number;
  ordinaryIncome: number;
  amtIncome: number;
  estimatedOrdinaryTax: number;
  estimatedAmtExposure: number;
  ltcgBasis: number;
}

const FEDERAL_ORDINARY_RATE = 0.37;
const FEDERAL_LTCG_RATE = 0.20;
const AMT_RATE = 0.28;
const AMT_EXEMPTION_2026 = 85_700;

function usd(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function usdExact(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseShares(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

function compute(
  optionType: OptionType,
  shares: number,
  strikePrice: number,
  fmv: number,
): TaxResult {
  const spread = Math.max(0, fmv - strikePrice);
  const totalSpread = spread * shares;

  if (optionType === 'nso') {
    const ordinaryIncome = totalSpread;
    const estimatedOrdinaryTax = ordinaryIncome * FEDERAL_ORDINARY_RATE;
    return {
      optionType,
      shares,
      strikePrice,
      fmv,
      spread,
      totalSpread,
      ordinaryIncome,
      amtIncome: 0,
      estimatedOrdinaryTax,
      estimatedAmtExposure: 0,
      ltcgBasis: fmv * shares,
    };
  }

  const amtIncome = totalSpread;
  const amtTaxable = Math.max(0, amtIncome - AMT_EXEMPTION_2026);
  const estimatedAmtExposure = amtTaxable * AMT_RATE;
  return {
    optionType,
    shares,
    strikePrice,
    fmv,
    spread,
    totalSpread,
    ordinaryIncome: 0,
    amtIncome,
    estimatedOrdinaryTax: 0,
    estimatedAmtExposure,
    ltcgBasis: strikePrice * shares,
  };
}

function ResultRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 border-b border-paper-200 py-2.5 last:border-b-0 ${highlight ? 'bg-bond-50' : ''}`}>
      <span className="text-sm text-ink-600">{label}</span>
      <span className="tnum text-sm font-semibold text-ink-900">{value}</span>
    </div>
  );
}

export function TaxCalculatorPage() {
  const [optionType, setOptionType] = useState<OptionType>('iso');
  const [sharesRaw, setSharesRaw] = useState('');
  const [strikeRaw, setStrikeRaw] = useState('');
  const [fmvRaw, setFmvRaw] = useState('');

  const shares = parseShares(sharesRaw);
  const strike = parseMoney(strikeRaw);
  const fmv = parseMoney(fmvRaw);
  const ready = shares !== null && strike !== null && fmv !== null && fmv > 0;

  const result = useMemo(() => {
    if (!ready) return null;
    return compute(optionType, shares!, strike!, fmv!);
  }, [optionType, shares, strike, fmv, ready]);

  const shareText = result
    ? optionType === 'iso'
      ? `Exercising ${shares!.toLocaleString()} ISOs at ${usdExact(strike!)} with FMV ${usdExact(fmv!)} — potential AMT exposure of ${usd(result.estimatedAmtExposure)}.`
      : `Exercising ${shares!.toLocaleString()} NSOs at ${usdExact(strike!)} with FMV ${usdExact(fmv!)} — estimated ordinary income tax of ${usd(result.estimatedOrdinaryTax)}.`
    : undefined;

  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <Seo {...pageMeta('/tools/stock-option-tax-calculator')!} />
      <div className="overline text-ink-400">Free tool</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">Stock Option Tax Calculator</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
        Estimate the tax implications of exercising your stock options. Compare ISO vs NSO treatment,
        see your AMT exposure, and understand your cost basis. Free, no signup required.
      </p>

      <div className="mt-10 grid gap-8 md:grid-cols-2">
        <form className="grid gap-5" onSubmit={(e) => e.preventDefault()}>
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-semibold text-ink-900">Option type</legend>
            <div className="flex gap-3">
              {([['iso', 'ISO (Incentive Stock Option)'], ['nso', 'NSO (Non-Qualified Stock Option)']] as const).map(
                ([value, label]) => (
                  <label
                    key={value}
                    className={`flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                      optionType === value
                        ? 'border-bond-600 bg-bond-50 text-bond-700'
                        : 'border-paper-300 bg-surface text-ink-700 hover:bg-paper-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="optionType"
                      value={value}
                      checked={optionType === value}
                      onChange={() => setOptionType(value)}
                      className="sr-only"
                    />
                    {label}
                  </label>
                ),
              )}
            </div>
          </fieldset>

          <label className="grid gap-1.5">
            <span className="text-sm font-semibold text-ink-900">Number of options to exercise</span>
            <input
              inputMode="numeric"
              value={sharesRaw}
              onChange={(e) => setSharesRaw(e.target.value)}
              placeholder="10,000"
              className="rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm font-semibold text-ink-900">Strike price (exercise price)</span>
            <input
              inputMode="decimal"
              value={strikeRaw}
              onChange={(e) => setStrikeRaw(e.target.value)}
              placeholder="$0.50"
              className="rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900"
            />
            <span className="text-xs text-ink-500">The price per share in your option grant.</span>
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm font-semibold text-ink-900">Current fair market value (FMV)</span>
            <input
              inputMode="decimal"
              value={fmvRaw}
              onChange={(e) => setFmvRaw(e.target.value)}
              placeholder="$5.00"
              className="rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900"
            />
            <span className="text-xs text-ink-500">From your company's most recent 409A valuation.</span>
          </label>
        </form>

        <div data-testid="tax-result">
          {!ready && (
            <div className="rounded-lg border border-dashed border-paper-300 p-6 text-sm text-ink-500">
              Enter your option details to see the tax estimate.
            </div>
          )}
          {result && (
            <div className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
              <div className="overline text-bond-700">
                {optionType === 'iso' ? 'ISO exercise' : 'NSO exercise'} — tax estimate
              </div>

              <div className="mt-2">
                <div className="tnum font-display text-3xl font-semibold text-ink-900">
                  {usd(result.totalSpread)}
                </div>
                <div className="text-xs text-ink-500">total bargain element (spread)</div>
              </div>

              <div className="mt-4">
                <ResultRow label="Spread per share" value={usdExact(result.spread)} />
                {optionType === 'nso' ? (
                  <>
                    <ResultRow label="Ordinary income at exercise" value={usd(result.ordinaryIncome)} />
                    <ResultRow
                      label={`Estimated federal tax (${Math.round(FEDERAL_ORDINARY_RATE * 100)}%)`}
                      value={usd(result.estimatedOrdinaryTax)}
                      highlight
                    />
                    <ResultRow label="Cost basis for future sale" value={usd(result.ltcgBasis)} />
                  </>
                ) : (
                  <>
                    <ResultRow label="AMT preference item" value={usd(result.amtIncome)} />
                    <ResultRow
                      label={`AMT exemption (2026)`}
                      value={usd(AMT_EXEMPTION_2026)}
                    />
                    <ResultRow
                      label={`Estimated AMT exposure (${Math.round(AMT_RATE * 100)}%)`}
                      value={usd(result.estimatedAmtExposure)}
                      highlight
                    />
                    <ResultRow label="Cost basis for future sale" value={usd(result.ltcgBasis)} />
                  </>
                )}
              </div>

              <ShareResultBar
                title="Stock option tax estimate"
                text={shareText!}
                className="mt-4"
              />
            </div>
          )}
        </div>
      </div>

      {result && (
        <section className="mt-10">
          <h2 className="font-display text-xl font-semibold text-ink-900">
            {optionType === 'iso' ? 'How ISO taxation works' : 'How NSO taxation works'}
          </h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {optionType === 'iso' ? (
              <>
                <div className="rounded-lg border border-paper-300 bg-surface p-4">
                  <h3 className="text-sm font-semibold text-ink-900">At exercise</h3>
                  <p className="mt-1 text-sm leading-relaxed text-ink-600">
                    No regular income tax. However, the spread between FMV and strike price is an
                    AMT preference item. If this pushes your AMT calculation above your regular tax,
                    you may owe AMT.
                  </p>
                </div>
                <div className="rounded-lg border border-paper-300 bg-surface p-4">
                  <h3 className="text-sm font-semibold text-ink-900">At sale (qualifying disposition)</h3>
                  <p className="mt-1 text-sm leading-relaxed text-ink-600">
                    If you hold for 1+ year after exercise and 2+ years after grant, the entire gain
                    above the strike price is taxed as long-term capital gains ({Math.round(FEDERAL_LTCG_RATE * 100)}% federal).
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-lg border border-paper-300 bg-surface p-4">
                  <h3 className="text-sm font-semibold text-ink-900">At exercise</h3>
                  <p className="mt-1 text-sm leading-relaxed text-ink-600">
                    The spread is taxed as ordinary income immediately, subject to federal income tax
                    and payroll taxes. Your employer reports this on your W-2.
                  </p>
                </div>
                <div className="rounded-lg border border-paper-300 bg-surface p-4">
                  <h3 className="text-sm font-semibold text-ink-900">At sale</h3>
                  <p className="mt-1 text-sm leading-relaxed text-ink-600">
                    Your cost basis is the FMV at exercise. Any additional gain above that is capital gains —
                    long-term if held 1+ year after exercise ({Math.round(FEDERAL_LTCG_RATE * 100)}% federal), short-term otherwise.
                  </p>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      <p className="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900">
        This calculator provides estimates based on 2026 federal tax rates and is for educational purposes only.
        It does not account for state taxes, payroll taxes, AMT credit carryforwards, or your specific tax situation.
        Consult a qualified tax advisor before making exercise decisions. This is not tax advice.
      </p>

      <section className="mt-14 border-t border-paper-200 pt-10">
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          Why the 409A valuation matters for your options
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
          The fair market value from your company's 409A valuation sets the strike price for new grants and
          determines the spread at exercise. A higher FMV means more tax at exercise; a lower FMV means a
          lower strike price (less cash out of pocket) but could trigger IRS penalties if it's not defensible.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Link
            to="/register"
            className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
          >
            Get your 409A valuation
          </Link>
          <Link to="/tools/409a-valuation-calculator" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
            Estimate your 409A value →
          </Link>
        </div>
      </section>
    </div>
  );
}
