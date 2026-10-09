import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Seo } from '../../components/Seo';
import { FaqAccordion } from '../../components/FaqAccordion';
import { pageMeta } from '../../lib/pageMeta';
import { ShareResultBar } from '../../components/ShareResultBar';
import type { FaqItem } from '../../lib/marketing';

interface Question {
  id: string;
  text: string;
  helpText: string;
  options: { label: string; value: string; score: number }[];
}

const QUESTIONS: Question[] = [
  {
    id: 'incorporation',
    text: 'When was your company incorporated?',
    helpText: 'Companies incorporated more recently may have simpler valuation considerations.',
    options: [
      { label: 'Less than 1 year ago', value: 'lt1', score: 8 },
      { label: '1–3 years ago', value: '1to3', score: 10 },
      { label: '3–5 years ago', value: '3to5', score: 10 },
      { label: 'More than 5 years ago', value: 'gt5', score: 10 },
    ],
  },
  {
    id: 'last_409a',
    text: 'When was your last 409A valuation?',
    helpText: 'A 409A valuation is valid for 12 months or until a material event occurs.',
    options: [
      { label: 'Never had one', value: 'never', score: 4 },
      { label: 'More than 12 months ago', value: 'gt12', score: 6 },
      { label: '6–12 months ago', value: '6to12', score: 9 },
      { label: 'Less than 6 months ago', value: 'lt6', score: 10 },
    ],
  },
  {
    id: 'funding',
    text: 'What is your most recent funding round?',
    helpText: 'Your funding stage determines which valuation approaches apply and complexity.',
    options: [
      { label: 'Pre-seed / Bootstrapped', value: 'preseed', score: 8 },
      { label: 'Seed / Angel', value: 'seed', score: 10 },
      { label: 'Series A or B', value: 'ab', score: 10 },
      { label: 'Series C+', value: 'c_plus', score: 10 },
    ],
  },
  {
    id: 'trigger',
    text: 'Have you had a triggering event recently?',
    helpText: 'New funding, M&A activity, IPO plans, or significant financial changes can invalidate an existing valuation.',
    options: [
      { label: 'Yes — new funding round', value: 'funding', score: 4 },
      { label: 'Yes — M&A or IPO plans', value: 'ma_ipo', score: 3 },
      { label: 'Yes — major revenue change', value: 'revenue', score: 5 },
      { label: 'No triggering events', value: 'none', score: 10 },
    ],
  },
  {
    id: 'revenue',
    text: 'What is your current annual revenue?',
    helpText: 'Revenue level affects which valuation methods and comparables are most appropriate.',
    options: [
      { label: 'Pre-revenue', value: 'pre', score: 7 },
      { label: 'Under $1M', value: 'lt1m', score: 9 },
      { label: '$1M–$10M', value: '1to10m', score: 10 },
      { label: 'Over $10M', value: 'gt10m', score: 10 },
    ],
  },
  {
    id: 'employees',
    text: 'How many employees does your company have?',
    helpText: 'Employee count affects option pool considerations and valuation complexity.',
    options: [
      { label: '1–10', value: 'lt10', score: 8 },
      { label: '11–50', value: '11to50', score: 10 },
      { label: '51–200', value: '51to200', score: 10 },
      { label: '200+', value: 'gt200', score: 10 },
    ],
  },
  {
    id: 'option_pool',
    text: 'Do you have an established equity option pool?',
    helpText: 'An option pool is required to grant stock options. Its size affects valuation.',
    options: [
      { label: 'No option pool yet', value: 'none', score: 5 },
      { label: 'Yes — under 10%', value: 'lt10', score: 9 },
      { label: 'Yes — 10–20%', value: '10to20', score: 10 },
      { label: 'Yes — over 20%', value: 'gt20', score: 10 },
    ],
  },
  {
    id: 'cap_table',
    text: 'Is your cap table current and complete?',
    helpText: 'A clean cap table is essential for an accurate 409A valuation. It should include all shares, options, warrants, SAFEs, and convertible notes.',
    options: [
      { label: 'No cap table', value: 'none', score: 3 },
      { label: 'Partial / outdated', value: 'partial', score: 6 },
      { label: 'Current but informal (spreadsheet)', value: 'spreadsheet', score: 8 },
      { label: 'Current in cap table software', value: 'software', score: 10 },
    ],
  },
  {
    id: 'financials',
    text: 'Are your financial statements up to date?',
    helpText: 'Recent financial statements (balance sheet, income statement) are needed for the valuation analysis.',
    options: [
      { label: 'No formal financial statements', value: 'none', score: 4 },
      { label: 'More than 6 months old', value: 'gt6', score: 6 },
      { label: 'Within the last 6 months', value: 'lt6', score: 9 },
      { label: 'Current (last quarter)', value: 'current', score: 10 },
    ],
  },
  {
    id: 'grants_planned',
    text: 'Are you planning to grant stock options soon?',
    helpText: 'Options must be priced at or above fair market value. Urgency determines recommended timeline.',
    options: [
      { label: 'Yes — within 30 days', value: '30d', score: 10 },
      { label: 'Yes — within 90 days', value: '90d', score: 10 },
      { label: 'Not immediately', value: 'later', score: 10 },
      { label: 'Not sure yet', value: 'unsure', score: 10 },
    ],
  },
];

interface ReadinessResult {
  score: number;
  label: string;
  summary: string;
  missing: string[];
  timeline: string;
}

function evaluate(answers: Record<string, string>): ReadinessResult | null {
  const answered = Object.keys(answers).length;
  if (answered < QUESTIONS.length) return null;

  let total = 0;
  const missing: string[] = [];

  for (const q of QUESTIONS) {
    const selected = q.options.find((o) => o.value === answers[q.id]);
    if (!selected) continue;
    total += selected.score;

    if (selected.score <= 5) {
      if (q.id === 'last_409a' && selected.value === 'never') missing.push('Obtain a 409A valuation');
      if (q.id === 'last_409a' && selected.value === 'gt12') missing.push('Update expired 409A valuation');
      if (q.id === 'trigger' && selected.value === 'funding') missing.push('New valuation needed after funding round');
      if (q.id === 'trigger' && selected.value === 'ma_ipo') missing.push('New valuation needed for M&A/IPO event');
      if (q.id === 'trigger' && selected.value === 'revenue') missing.push('Consider updated valuation after revenue change');
      if (q.id === 'option_pool' && selected.value === 'none') missing.push('Establish equity option pool');
      if (q.id === 'cap_table' && selected.value === 'none') missing.push('Create and maintain a cap table');
      if (q.id === 'financials' && selected.value === 'none') missing.push('Prepare formal financial statements');
    } else if (selected.score <= 7) {
      if (q.id === 'cap_table' && selected.value === 'partial') missing.push('Update and complete your cap table');
      if (q.id === 'financials' && selected.value === 'gt6') missing.push('Update financial statements (>6 months old)');
      if (q.id === 'last_409a' && selected.value === '6to12') missing.push('Plan for 409A renewal (approaching 12-month expiry)');
      if (q.id === 'revenue' && selected.value === 'pre') missing.push('Prepare revenue projections for valuation');
    }
  }

  const maxScore = QUESTIONS.length * 10;
  const pct = Math.round((total / maxScore) * 100);

  const urgentGrant = answers.grants_planned === '30d';
  const soonGrant = answers.grants_planned === '90d';

  let timeline: string;
  if (urgentGrant) {
    timeline = 'Express delivery recommended — 1–3 business days with DoAide';
  } else if (soonGrant) {
    timeline = 'Standard delivery — 1–2 weeks with DoAide';
  } else {
    timeline = 'Standard timeline — 2–3 weeks is typical';
  }

  let label: string;
  let summary: string;
  if (pct >= 85) {
    label = 'Ready';
    summary = 'Your company is well-prepared for a 409A valuation. You have the key documents and data in place.';
  } else if (pct >= 65) {
    label = 'Almost ready';
    summary = 'You are close to being ready, but a few items need attention before starting your valuation.';
  } else {
    label = 'Needs preparation';
    summary = 'Several items need to be addressed before you can get an accurate 409A valuation.';
  }

  return { score: pct, label, summary, missing, timeline };
}

const READINESS_FAQ: FaqItem[] = [
  {
    q: 'What documents do I need for a 409A valuation?',
    a: 'At minimum: your cap table, recent financial statements (balance sheet and income statement), articles of incorporation, and details of any recent funding rounds including term sheets or SAFE/convertible note agreements.',
  },
  {
    q: 'How often do I need a 409A valuation?',
    a: 'At least every 12 months, or whenever a material event occurs — such as a new funding round, M&A activity, IPO filing, or significant change in financial performance.',
  },
  {
    q: 'What if I have never had a 409A valuation?',
    a: 'If you plan to grant stock options, you need a 409A valuation first. Granting options without one risks IRC §409A penalties: immediate income tax plus a 20% penalty tax for option holders.',
  },
  {
    q: 'Can I start a valuation if my cap table is not perfect?',
    a: 'Yes — our analysts can work with you to clean up your cap table as part of the intake process. Having a rough version is better than none, and we will flag any gaps.',
  },
  {
    q: 'How long does a 409A valuation take?',
    a: 'With DoAide, standard delivery is 7 days with a first draft in 24 hours. Express delivery (1 business day) is available for urgent grants. Traditional providers typically take 2–6 weeks.',
  },
];

function ScoreGauge({ score }: { score: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 85 ? '#22c55e' : score >= 65 ? '#eab308' : '#ef4444';

  return (
    <div className="flex flex-col items-center" data-testid="readiness-score">
      <svg width="140" height="140" viewBox="0 0 140 140" aria-hidden="true">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 70 70)"
          style={{ transition: 'stroke-dashoffset 1s ease-out' }}
        />
        <text x="70" y="66" textAnchor="middle" fill={color} fontSize="32" fontWeight="700" fontFamily="'IBM Plex Mono', monospace">
          {score}%
        </text>
        <text x="70" y="86" textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="11">
          readiness
        </text>
      </svg>
    </div>
  );
}

export function ReadinessCheckerPage() {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [currentStep, setCurrentStep] = useState(0);

  const result = evaluate(answers);
  const answeredCount = Object.keys(answers).length;
  const progress = (answeredCount / QUESTIONS.length) * 100;

  const shareText = result
    ? `409A Readiness Score: ${result.score}% — ${result.label}. ${result.summary}`
    : undefined;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const whatsappShareText = result
    ? `\u{1F4CA} My 409A Readiness Score: ${result.score}% (${result.label})\n\n${result.summary}\n\nCheck yours free \u{2192} ${origin}/tools/readiness-checker`
    : undefined;

  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <Seo {...pageMeta('/tools/readiness-checker')!} />
      <div className="overline text-ink-400">Free tool</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
        409A Valuation Readiness Checker
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
        Answer {QUESTIONS.length} questions about your company to find out if you are ready for a
        409A valuation. Get a readiness score, missing-items checklist, and estimated timeline.
        Free, instant, no signup required.
      </p>

      {/* Progress bar */}
      <div className="mt-8 h-2 rounded-full bg-paper-200">
        <div
          className="h-2 rounded-full bg-bond-600 transition-all duration-300"
          style={{ width: `${progress}%` }}
          role="progressbar"
          aria-valuenow={answeredCount}
          aria-valuemin={0}
          aria-valuemax={QUESTIONS.length}
          aria-label="Questions answered"
        />
      </div>
      <p className="mt-1 text-xs text-ink-400">
        {answeredCount} of {QUESTIONS.length} answered
      </p>

      <div className="mt-8 grid gap-8 md:grid-cols-2">
        {/* Questions */}
        <div className="grid gap-4">
          {QUESTIONS.map((q, i) => (
            <div
              key={q.id}
              className={`rounded-lg border p-4 transition-colors ${
                answers[q.id]
                  ? 'border-bond-200 bg-bond-50/30'
                  : i === currentStep
                    ? 'border-bond-400 bg-surface shadow-card'
                    : 'border-paper-300 bg-surface'
              }`}
              data-testid={`question-${q.id}`}
            >
              <div className="flex gap-3">
                <span className="tnum shrink-0 text-sm font-semibold text-bond-600">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-ink-900">{q.text}</div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-500">{q.helpText}</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {q.options.map((opt) => {
                      const isSelected = answers[q.id] === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => {
                            setAnswers((a) => ({ ...a, [q.id]: opt.value }));
                            if (i < QUESTIONS.length - 1) setCurrentStep(i + 1);
                          }}
                          className={`cursor-pointer rounded-md border px-3 py-2 text-left text-xs font-medium transition-colors ${
                            isSelected
                              ? 'border-bond-600 bg-bond-50 text-bond-700'
                              : 'border-paper-300 bg-surface text-ink-600 hover:bg-paper-50'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Result panel */}
        <div data-testid="readiness-result">
          {!result && (
            <div className="sticky top-20 rounded-lg border border-dashed border-paper-300 p-6 text-center text-sm text-ink-500">
              <p>Answer all {QUESTIONS.length} questions to see your readiness score.</p>
              <p className="mt-2 text-xs text-ink-400">
                {QUESTIONS.length - answeredCount} remaining
              </p>
            </div>
          )}
          {result && (
            <div className="sticky top-20 space-y-4">
              <div className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
                <ScoreGauge score={result.score} />
                <div className="mt-4 text-center">
                  <div className="font-display text-xl font-semibold text-ink-900">{result.label}</div>
                  <p className="mt-2 text-sm leading-relaxed text-ink-600">{result.summary}</p>
                </div>
              </div>

              {result.missing.length > 0 && (
                <div className="rounded-lg border border-paper-300 bg-surface p-5">
                  <h3 className="text-sm font-semibold text-ink-900">Missing items</h3>
                  <ul className="mt-3 space-y-2">
                    {result.missing.map((item) => (
                      <li key={item} className="flex gap-2 text-sm text-ink-700">
                        <span className="text-red-500">✕</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rounded-lg border border-paper-300 bg-surface p-5">
                <h3 className="text-sm font-semibold text-ink-900">Estimated timeline</h3>
                <p className="mt-2 text-sm text-ink-600">{result.timeline}</p>
              </div>

              <ShareResultBar
                title="409A readiness check"
                text={shareText!}
                emailSubject="409A Readiness Score"
                emailLabel="Share with your team"
                whatsappText={whatsappShareText}
                className="mt-2"
              />

              <div className="flex flex-wrap items-center gap-3">
                <Link
                  to="/register"
                  className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
                >
                  {result.score >= 85 ? 'Start your 409A valuation' : 'Get help preparing'}
                </Link>
                <Link
                  to="/tools/409a-valuation-calculator"
                  className="text-sm font-semibold text-bond-600 hover:text-bond-700"
                >
                  Estimate your value →
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* FAQ section */}
      <section className="mt-14 border-t border-paper-200 pt-10">
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          Frequently asked questions
        </h2>
        <div className="mt-6">
          <FaqAccordion items={READINESS_FAQ} />
        </div>
      </section>
    </div>
  );
}
