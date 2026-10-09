import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Seo } from '../../components/Seo';
import { FaqAccordion } from '../../components/FaqAccordion';
import { pageMeta } from '../../lib/pageMeta';
import { siteOrigin } from '../../lib/seo';
import type { FaqItem } from '../../lib/marketing';

interface Deadline {
  id: string;
  label: string;
  description: string;
  months: number;
  urgent: boolean;
}

const DEADLINES: Deadline[] = [
  {
    id: '12-month-expiry',
    label: '12-month valuation expiry',
    description:
      'A 409A valuation is valid for 12 months from its effective date. After that, any options granted rely on an expired valuation and lose safe harbor protection.',
    months: 12,
    urgent: true,
  },
  {
    id: 'post-funding',
    label: 'Post-funding round valuation',
    description:
      'A new priced equity round is a material event that invalidates the current 409A. You need a new valuation before granting any options after the round closes.',
    months: 0,
    urgent: true,
  },
  {
    id: 'annual-audit',
    label: 'Annual financial audit (ASC 718)',
    description:
      'If your company reports stock-based compensation expense under ASC 718, auditors will ask for the 409A valuation supporting each grant made during the fiscal year.',
    months: 12,
    urgent: false,
  },
  {
    id: 'board-approval',
    label: 'Board option grant approval',
    description:
      'Options must be priced at or above fair market value on the grant date. The board resolution should reference a current 409A valuation.',
    months: 0,
    urgent: false,
  },
  {
    id: 'ipo-readiness',
    label: 'IPO readiness / S-1 filing',
    description:
      'SEC and underwriter counsel will review every 409A valuation from the prior 3 years. Cheap-stock exposure peaks in the 12 months before an IPO filing.',
    months: 0,
    urgent: false,
  },
  {
    id: 'year-end-refresh',
    label: 'Year-end valuation refresh',
    description:
      'Many companies align their 409A effective date with fiscal year-end so all grants in the following year are covered. Order by November for a December effective date.',
    months: 12,
    urgent: false,
  },
];

function monthsUntil(months: number): string {
  if (months === 0) return 'Event-driven';
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() + months, now.getDate());
  const diff = Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (diff <= 30) return `${diff} days`;
  if (diff <= 90) return `${Math.ceil(diff / 7)} weeks`;
  return `${Math.round(diff / 30)} months`;
}

function DeadlineCard({ deadline }: { deadline: Deadline }) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        deadline.urgent
          ? 'border-red-200 bg-red-50/50'
          : 'border-paper-300 bg-surface'
      }`}
      data-testid={`deadline-${deadline.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            {deadline.urgent && (
              <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700">
                Urgent
              </span>
            )}
            <h3 className="text-sm font-semibold text-ink-900">{deadline.label}</h3>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-600">{deadline.description}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="tnum text-xs font-semibold text-ink-500">
            {monthsUntil(deadline.months)}
          </div>
        </div>
      </div>
    </div>
  );
}

const EMBED_FAQ: FaqItem[] = [
  {
    q: 'How do I embed this widget on my site?',
    a: 'Copy the embed code above and paste it into your HTML. The widget loads in an iframe and adapts to your page width. No JavaScript dependencies required.',
  },
  {
    q: 'Is the widget free to use?',
    a: 'Yes, the 409A deadline widget is completely free. We provide it as a resource for the startup ecosystem. Attribution to DoAide 409A is included in the widget footer.',
  },
  {
    q: 'Can I customise the widget appearance?',
    a: 'The widget uses a neutral design that works with most sites. You can adjust the iframe width and height. For custom branding, contact us about our partner programme.',
  },
  {
    q: 'How often are the deadlines updated?',
    a: 'The deadline information reflects current IRS guidance and best practices. The widget is updated whenever regulatory requirements change.',
  },
];

export function DeadlineWidgetPage() {
  const [copied, setCopied] = useState(false);
  const origin = siteOrigin();
  const embedCode = `<iframe src="${origin}/tools/deadline-widget/embed" width="100%" height="520" style="border:none;border-radius:8px" title="409A valuation deadlines"></iframe>`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(embedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available */
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <Seo {...pageMeta('/tools/deadline-widget')!} />
      <div className="overline text-ink-400">Free tool</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
        409A Valuation Deadline Tracker
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-600">
        Key 409A deadlines and compliance reminders for startups. Embed this widget on your site to
        help your portfolio companies stay compliant.
      </p>

      {/* Deadlines list */}
      <div className="mt-8 grid gap-3" data-testid="deadline-list">
        {DEADLINES.map((d) => (
          <DeadlineCard key={d.id} deadline={d} />
        ))}
      </div>

      {/* CTA */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link
          to="/register"
          className="rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700"
        >
          Start your 409A valuation
        </Link>
        <Link
          to="/tools/readiness-checker"
          className="text-sm font-semibold text-bond-600 hover:text-bond-700"
        >
          Check your readiness →
        </Link>
      </div>

      {/* Embed section */}
      <section className="mt-14 border-t border-paper-200 pt-10">
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          Embed on your site
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">
          Add this widget to your startup blog, accelerator site, or law firm website. It helps
          your audience stay on top of 409A compliance deadlines.
        </p>
        <div className="mt-4 rounded-lg border border-paper-300 bg-paper-50 p-4">
          <pre className="overflow-x-auto overscroll-x-contain text-xs text-ink-700" data-testid="embed-code">
            <code>{embedCode}</code>
          </pre>
          <button
            type="button"
            onClick={handleCopy}
            className="mt-3 cursor-pointer rounded-md border border-paper-300 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-700 transition-colors hover:bg-paper-50"
          >
            {copied ? 'Copied!' : 'Copy embed code'}
          </button>
        </div>
      </section>

      {/* FAQ */}
      <section className="mt-14 border-t border-paper-200 pt-10">
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          Frequently asked questions
        </h2>
        <div className="mt-6">
          <FaqAccordion items={EMBED_FAQ} />
        </div>
      </section>
    </div>
  );
}

/**
 * Lightweight embeddable version of the deadline list. Rendered at
 * /tools/deadline-widget/embed — designed to be loaded in an iframe.
 */
export function DeadlineWidgetEmbed() {
  const origin = siteOrigin();
  return (
    <div className="mx-auto max-w-lg px-4 py-5" data-testid="deadline-embed">
      <h2 className="font-display text-lg font-semibold text-ink-900">
        409A Valuation Deadlines
      </h2>
      <p className="mt-1 text-xs text-ink-500">Key compliance dates for startups</p>
      <div className="mt-4 grid gap-2">
        {DEADLINES.filter((d) => d.urgent).map((d) => (
          <div
            key={d.id}
            className="rounded-md border border-red-200 bg-red-50/50 px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-red-700">
                Urgent
              </span>
              <span className="text-xs font-semibold text-ink-900">{d.label}</span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-600">{d.description}</p>
          </div>
        ))}
        {DEADLINES.filter((d) => !d.urgent).map((d) => (
          <div
            key={d.id}
            className="rounded-md border border-paper-300 px-3 py-2.5"
          >
            <span className="text-xs font-semibold text-ink-900">{d.label}</span>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-600">{d.description}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 border-t border-paper-200 pt-3 text-center">
        <a
          href={`${origin}/tools/readiness-checker`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-semibold text-bond-600 hover:text-bond-700"
        >
          Check your 409A readiness →
        </a>
        <p className="mt-1 text-[10px] text-ink-400">
          Powered by{' '}
          <a
            href={origin}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-ink-500 hover:text-bond-600"
          >
            DoAide 409A
          </a>
        </p>
      </div>
    </div>
  );
}
