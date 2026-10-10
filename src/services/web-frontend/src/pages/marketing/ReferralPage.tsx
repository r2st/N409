import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Seo } from '../../components/Seo';
import { FaqAccordion } from '../../components/FaqAccordion';
import { pageMeta } from '../../lib/pageMeta';
import { ShareResultBar } from '../../components/ShareResultBar';
import { siteOrigin } from '../../lib/seo';
import { OFFLINE_DETAIL } from '../../lib/api';
import type { FaqItem } from '../../lib/marketing';

interface ReferralBenefit {
  icon: React.ReactNode;
  title: string;
  description: string;
}

const BENEFITS: ReferralBenefit[] = [
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v12M9 9c0-1.5 1.3-3 3-3s3 1.5 3 3c0 2-3 2.5-3 4M12 17h.01" />
      </svg>
    ),
    title: 'Revenue share',
    description: 'Earn a recurring percentage on every valuation your referred clients complete. No caps, no limits.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
    title: 'Defensible reports',
    description: 'Your clients get audit-defensible, analyst-signed 409A valuations. Your reputation stays intact.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="2" y="3" width="20" height="18" rx="2" />
        <path d="M8 7h8M8 11h8M8 15h4" />
      </svg>
    ),
    title: 'Referral dashboard',
    description: 'Track referrals, see which clients ordered, and monitor your earnings from one portal.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
    title: '24-hour turnaround',
    description: 'First draft in 24 hours, not 2-6 weeks. Your clients get their valuations faster, making you look good.',
  },
];

const AUDIENCES = [
  {
    title: 'Startup Lawyers',
    description: 'You advise on equity plans, option grants, and SAFE conversions. Your clients need a 409A before every option grant — send them our way.',
    stat: '3-5',
    statLabel: 'valuations per client per year',
  },
  {
    title: 'CFOs & Controllers',
    description: 'You manage the compliance calendar. When the 12-month expiry hits or a new round closes, you need a valuation fast.',
    stat: '24h',
    statLabel: 'first draft turnaround',
  },
  {
    title: 'Accelerators & VCs',
    description: 'Your portfolio companies all need 409As after each round. Refer them to one platform and simplify your recommendations.',
    stat: '10-50',
    statLabel: 'portfolio companies per fund',
  },
];

const REFERRAL_FAQ: FaqItem[] = [
  {
    q: 'How does the referral program work?',
    a: 'Sign up as a referral partner, get your unique referral link, and share it with startups that need 409A valuations. You earn a revenue share on every completed valuation from your referred clients.',
  },
  {
    q: 'How much can I earn?',
    a: 'Referral partners earn a percentage of each valuation ordered through their referral link. The exact terms depend on volume — contact us for details.',
  },
  {
    q: 'Is there a minimum number of referrals?',
    a: 'No. There is no minimum. Whether you refer one startup or a hundred, you earn on every completed valuation.',
  },
  {
    q: 'How is this different from the full partner programme?',
    a: 'The referral programme is lightweight — share a link, earn a fee. The full partner programme includes white-label branding, your own subdomain, API access, and co-signed reports. If your firm delivers valuations, the partner programme may be a better fit.',
  },
  {
    q: 'Can my clients see that I referred them?',
    a: 'No. The referral is tracked internally. Your clients see a standard DoAide 409A experience with no indication of how they arrived.',
  },
];

export function ReferralPage() {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [formData, setFormData] = useState({ name: '', email: '', company: '', role: '' });

  const origin = siteOrigin();
  const shareText = `I'm a referral partner with DoAide 409A — the fastest way to get a defensible 409A valuation. Get yours at ${origin}/referral`;
  const whatsappText = `\u{1F91D} I refer my startup clients to DoAide for their 409A valuations — 24-hour turnaround, audit-defensible reports.\n\nCheck it out \u{2192} ${origin}/referral`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/referral-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body.detail ??
            `Your application could not be submitted (${res.status}). Nothing was saved — check your entries and try again.`,
        );
      }
      setSubmitted(true);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : OFFLINE_DETAIL,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-5 py-16">
      <Seo {...pageMeta('/referral')!} />

      {/* Hero */}
      <div className="text-center">
        <div className="overline text-ink-400">Referral programme</div>
        <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">
          Earn by referring 409A valuations
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-ink-600">
          Startup lawyers, CFOs, and accelerators — your clients need 409A valuations. Refer them to
          DoAide and earn a revenue share on every completed valuation.
        </p>
      </div>

      {/* Benefits grid */}
      <div className="mt-12 grid gap-6 sm:grid-cols-2">
        {BENEFITS.map((b) => (
          <div key={b.title} className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
            <div className="text-bond-600">{b.icon}</div>
            <h3 className="mt-3 font-display text-base font-semibold text-ink-900">{b.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">{b.description}</p>
          </div>
        ))}
      </div>

      {/* Audience segments */}
      <section className="mt-14">
        <h2 className="text-center font-display text-2xl font-semibold text-ink-900">
          Built for professionals who advise startups
        </h2>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {AUDIENCES.map((a) => (
            <div key={a.title} className="rounded-lg border border-paper-300 bg-surface p-5">
              <h3 className="font-display text-base font-semibold text-ink-900">{a.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">{a.description}</p>
              <div className="mt-4 border-t border-paper-200 pt-3">
                <div className="font-display text-xl font-bold text-bond-600">{a.stat}</div>
                <div className="text-xs text-ink-500">{a.statLabel}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="mt-14 border-t border-paper-200 pt-10">
        <h2 className="text-center font-display text-2xl font-semibold text-ink-900">
          How it works
        </h2>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {[
            { step: '01', title: 'Sign up', description: 'Fill out the form below. We will set up your referral account within 24 hours.' },
            { step: '02', title: 'Share your link', description: 'Share your unique referral link with startup clients who need 409A valuations.' },
            { step: '03', title: 'Earn', description: 'When your referred clients complete a valuation, you earn a revenue share. Tracked and paid automatically.' },
          ].map((s) => (
            <div key={s.step} className="text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-bond-600 text-sm font-bold text-bond-fg">
                {s.step}
              </div>
              <h3 className="mt-3 font-display text-base font-semibold text-ink-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">{s.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Signup form */}
      <section className="mt-14 border-t border-paper-200 pt-10" id="signup">
        <div className="mx-auto max-w-lg">
          <h2 className="text-center font-display text-2xl font-semibold text-ink-900">
            Join the referral programme
          </h2>
          {submitted ? (
            <div className="mt-6 rounded-lg border border-green-200 bg-green-50 p-6 text-center" data-testid="referral-success">
              <h3 className="font-display text-lg font-semibold text-green-800">Application received</h3>
              <p className="mt-2 text-sm text-green-700">
                We will review your application and set up your referral account within 24 hours.
                You will receive your unique referral link by email.
              </p>
              <div className="mt-4">
                <ShareResultBar
                  title="DoAide 409A Referral"
                  text={shareText}
                  emailSubject="409A Valuation Referral Partner"
                  emailLabel="Share via email"
                  whatsappText={whatsappText}
                />
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 grid gap-4" data-testid="referral-form">
              <div>
                <label htmlFor="ref-name" className="block text-xs font-semibold text-ink-700">Full name</label>
                <input
                  id="ref-name"
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData((d) => ({ ...d, name: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900 outline-none focus:border-bond-500 focus:ring-1 focus:ring-bond-500"
                />
              </div>
              <div>
                <label htmlFor="ref-email" className="block text-xs font-semibold text-ink-700">Work email</label>
                <input
                  id="ref-email"
                  type="email"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData((d) => ({ ...d, email: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900 outline-none focus:border-bond-500 focus:ring-1 focus:ring-bond-500"
                />
              </div>
              <div>
                <label htmlFor="ref-company" className="block text-xs font-semibold text-ink-700">Company / Firm</label>
                <input
                  id="ref-company"
                  type="text"
                  required
                  value={formData.company}
                  onChange={(e) => setFormData((d) => ({ ...d, company: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900 outline-none focus:border-bond-500 focus:ring-1 focus:ring-bond-500"
                />
              </div>
              <div>
                <label htmlFor="ref-role" className="block text-xs font-semibold text-ink-700">Your role</label>
                <select
                  id="ref-role"
                  required
                  value={formData.role}
                  onChange={(e) => setFormData((d) => ({ ...d, role: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-paper-300 bg-surface px-3 py-2 text-sm text-ink-900 outline-none focus:border-bond-500 focus:ring-1 focus:ring-bond-500"
                >
                  <option value="">Select your role</option>
                  <option value="lawyer">Startup Lawyer</option>
                  <option value="cfo">CFO / Controller</option>
                  <option value="accelerator">Accelerator / Incubator</option>
                  <option value="vc">Venture Capital</option>
                  <option value="cpa">CPA / Accounting Firm</option>
                  <option value="other">Other</option>
                </select>
              </div>
              {submitError && (
                <p className="text-sm text-red-600" role="alert">{submitError}</p>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="mt-2 w-full cursor-pointer rounded-md bg-bond-600 px-5 py-2.5 text-sm font-semibold text-bond-fg shadow-card transition-colors hover:bg-bond-700 disabled:opacity-60"
              >
                {submitting ? 'Submitting…' : 'Apply to join'}
              </button>
              <p className="text-center text-xs text-ink-400">
                Already a partner?{' '}
                <Link to="/partners" className="text-bond-600 hover:text-bond-700">
                  See the full partner programme →
                </Link>
              </p>
            </form>
          )}
        </div>
      </section>

      {/* FAQ */}
      <section className="mt-14 border-t border-paper-200 pt-10">
        <h2 className="font-display text-2xl font-semibold text-ink-900">
          Frequently asked questions
        </h2>
        <div className="mt-6">
          <FaqAccordion items={REFERRAL_FAQ} />
        </div>
      </section>
    </div>
  );
}
