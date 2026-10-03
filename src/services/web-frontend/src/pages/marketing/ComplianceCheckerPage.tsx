import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';
import { ShareResultBar } from '../../components/ShareResultBar';

interface Question {
  id: string;
  text: string;
  helpText: string;
  yesIsGood: boolean;
}

const QUESTIONS: Question[] = [
  {
    id: 'has_409a',
    text: 'Does your company have a current 409A valuation?',
    helpText: 'A 409A valuation is valid for 12 months or until a material event (e.g., a new funding round).',
    yesIsGood: true,
  },
  {
    id: 'within_12m',
    text: 'Was it completed within the last 12 months?',
    helpText: 'The IRS safe harbor requires a new valuation at least every 12 months.',
    yesIsGood: true,
  },
  {
    id: 'material_event',
    text: 'Has there been a material event since the last valuation (funding round, M&A offer, major revenue change)?',
    helpText: 'A material event can invalidate an existing 409A valuation, even if it is less than 12 months old.',
    yesIsGood: false,
  },
  {
    id: 'independent',
    text: 'Was the valuation performed by a qualified independent appraiser?',
    helpText: 'IRS Revenue Ruling 59-60 and IRC §409A require independence. An internal estimate does not qualify for safe harbor.',
    yesIsGood: true,
  },
  {
    id: 'granting_options',
    text: 'Are you planning to grant stock options in the next 90 days?',
    helpText: 'Options must be granted at or above fair market value. Granting without a current 409A risks §409A penalties.',
    yesIsGood: false,
  },
];

type Status = 'compliant' | 'at_risk' | 'non_compliant';

interface CheckResult {
  status: Status;
  title: string;
  summary: string;
  recommendations: string[];
  urgency: string;
}

function evaluate(answers: Record<string, boolean | null>): CheckResult | null {
  const answered = Object.values(answers).filter((v) => v !== null);
  if (answered.length < QUESTIONS.length) return null;

  const has409a = answers.has_409a;
  const within12m = answers.within_12m;
  const materialEvent = answers.material_event;
  const independent = answers.independent;
  const grantingSoon = answers.granting_options;

  if (!has409a) {
    return {
      status: 'non_compliant',
      title: 'Not compliant',
      summary: 'Your company does not have a 409A valuation. Any outstanding option grants may have been issued below fair market value.',
      recommendations: [
        'Obtain a 409A valuation before granting any stock options.',
        'If options have already been granted without a 409A, consult tax counsel about §409A correction programs.',
        'A retroactive valuation may help establish defensible pricing for recent grants.',
      ],
      urgency: grantingSoon ? 'Urgent — you cannot grant options without a current 409A valuation.' : 'Important — address this before your next option grant.',
    };
  }

  if (!within12m || materialEvent) {
    const reasons = [];
    if (!within12m) reasons.push('your valuation is more than 12 months old');
    if (materialEvent) reasons.push('a material event has occurred since the last valuation');

    return {
      status: grantingSoon ? 'non_compliant' : 'at_risk',
      title: grantingSoon ? 'Action required' : 'At risk',
      summary: `Your 409A valuation may no longer be valid because ${reasons.join(' and ')}.`,
      recommendations: [
        'Commission an updated 409A valuation as soon as possible.',
        ...(grantingSoon ? ['Do not grant options until the new valuation is complete.'] : []),
        ...(materialEvent ? ['Document the material event and its impact on company value for your appraiser.'] : []),
      ],
      urgency: grantingSoon
        ? 'Urgent — granting options on a stale valuation does not qualify for IRS safe harbor.'
        : 'Moderate — update before your next grant or board meeting.',
    };
  }

  if (!independent) {
    return {
      status: 'at_risk',
      title: 'Partially compliant',
      summary: 'You have a recent valuation, but it may not qualify for the IRS safe harbor because it was not performed by an independent appraiser.',
      recommendations: [
        'Consider engaging a qualified independent appraiser for your next valuation.',
        'An internal valuation may still be defensible but does not automatically qualify for safe harbor protection.',
        'Safe harbor shifts the burden of proof to the IRS — without it, your company bears the burden.',
      ],
      urgency: 'Moderate — your current valuation is defensible but does not have safe harbor protection.',
    };
  }

  return {
    status: 'compliant',
    title: 'Compliant',
    summary: 'Your company appears to have a current, independent 409A valuation that qualifies for IRS safe harbor protection.',
    recommendations: [
      'Set a calendar reminder for 30 days before the 12-month anniversary to start the next valuation.',
      'Document any material events that occur — they may trigger the need for an interim valuation.',
      ...(grantingSoon ? ['You are clear to grant options at or above the appraised fair market value.'] : []),
    ],
    urgency: 'No immediate action needed. Keep your valuation current.',
  };
}

const STATUS_STYLES: Record<Status, { bg: string; border: string; icon: string; accent: string }> = {
  compliant: { bg: 'bg-emerald-50', border: 'border-emerald-200', icon: '✓', accent: 'text-emerald-700' },
  at_risk: { bg: 'bg-amber-50', border: 'border-amber-200', icon: '⚠', accent: 'text-amber-700' },
  non_compliant: { bg: 'bg-red-50', border: 'border-red-200', icon: '✕', accent: 'text-red-700' },
};

export function ComplianceCheckerPage() {
  const [answers, setAnswers] = useState<Record<string, boolean | null>>(
    Object.fromEntries(QUESTIONS.map((q) => [q.id, null])),
  );

  const result = evaluate(answers);

  const shareText = result
    ? `409A compliance check: ${result.title}. ${result.summary}`
    : undefined;

  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <Seo {...pageMeta('/tools/409a-compliance-checker')!} />
      <div className="overline text-ink-400">Free tool</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">409A Compliance Checker</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
        Answer five questions to check whether your company's 409A valuation is current and
        compliant with IRS safe harbor requirements. Free, instant, no signup required.
      </p>

      <div className="mt-10 grid gap-8 md:grid-cols-2">
        <div className="grid gap-4">
          {QUESTIONS.map((q, i) => (
            <div key={q.id} className="rounded-lg border border-paper-300 bg-surface p-4" data-testid={`question-${q.id}`}>
              <div className="flex gap-3">
                <span className="tnum shrink-0 text-sm font-semibold text-bond-600">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-ink-900">{q.text}</div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-500">{q.helpText}</p>
                  <div className="mt-3 flex gap-3">
                    {(['yes', 'no'] as const).map((choice) => {
                      const isSelected = answers[q.id] === (choice === 'yes');
                      return (
                        <button
                          key={choice}
                          type="button"
                          onClick={() => setAnswers((a) => ({ ...a, [q.id]: choice === 'yes' }))}
                          className={`cursor-pointer rounded-md border px-4 py-1.5 text-sm font-semibold transition-colors ${
                            isSelected
                              ? 'border-bond-600 bg-bond-50 text-bond-700'
                              : 'border-paper-300 bg-surface text-ink-600 hover:bg-paper-50'
                          }`}
                        >
                          {choice === 'yes' ? 'Yes' : 'No'}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div data-testid="compliance-result">
          {!result && (
            <div className="rounded-lg border border-dashed border-paper-300 p-6 text-sm text-ink-500">
              Answer all five questions to see your compliance status.
            </div>
          )}
          {result && (() => {
            const style = STATUS_STYLES[result.status];
            return (
              <div className={`rounded-lg border ${style.border} ${style.bg} p-6 shadow-card`}>
                <div className="flex items-center gap-3">
                  <span className={`text-2xl ${style.accent}`}>{style.icon}</span>
                  <div className={`font-display text-2xl font-semibold ${style.accent}`}>
                    {result.title}
                  </div>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-700">{result.summary}</p>
                <div className="mt-4 rounded-md border border-paper-200 bg-surface/60 p-3">
                  <div className="text-xs font-semibold text-ink-900">Urgency</div>
                  <p className="mt-1 text-xs text-ink-600">{result.urgency}</p>
                </div>
                <div className="mt-4">
                  <div className="text-xs font-semibold text-ink-900">Recommendations</div>
                  <ul className="mt-2 space-y-2">
                    {result.recommendations.map((r) => (
                      <li key={r} className="flex gap-2 text-sm text-ink-700">
                        <span className="text-bond-600">→</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>

                <ShareResultBar
                  title="409A compliance check"
                  text={shareText!}
                  emailSubject="409A Compliance Status"
                  emailLabel="Share with your CFO"
                  className="mt-4"
                />

                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <Link
                    to="/register"
                    className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
                  >
                    {result.status === 'compliant' ? 'Get your next 409A' : 'Get your 409A valuation now'}
                  </Link>
                  <Link to="/tools/409a-valuation-calculator" className="text-sm font-semibold text-bond-600 hover:text-bond-700">
                    Estimate your value →
                  </Link>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      <section className="mt-14 border-t border-paper-200 pt-10">
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          What happens if you're not compliant?
        </h2>
        <div className="mt-6 grid gap-5 md:grid-cols-3">
          {[
            {
              title: 'IRC §409A penalties',
              body: 'Options granted below FMV are treated as deferred compensation. The option holder owes income tax immediately, plus a 20% penalty tax and interest from the date of vesting.',
            },
            {
              title: 'No safe harbor protection',
              body: 'Without a qualified independent appraisal, the burden of proving fair market value falls on your company. The IRS can challenge your valuation and impose penalties retroactively.',
            },
            {
              title: 'Employee impact',
              body: 'Employees and executives bearing §409A penalties often results in morale issues, disputes, and potential lawsuits. The company typically ends up making the affected employees whole.',
            },
          ].map((item) => (
            <div key={item.title} className="rounded-lg border border-paper-300 bg-surface p-4">
              <h3 className="text-sm font-semibold text-ink-900">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">{item.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
