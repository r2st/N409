import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Button, ErrorNote, Field, TextInput } from '../../components/ui';
import { PhoneInput, phoneFieldError } from '../../components/PhoneInput';
import { Seo } from '../../components/Seo';
import { siteConfig } from '../../lib/siteConfig';

/** About / contact / legal pages (409.ai §22.7) — static content. */

function Prose({
  title,
  overline,
  path,
  description,
  children,
}: {
  title: string;
  overline: string;
  /** Canonical path for SEO tags. */
  path: string;
  /** Meta/OG description for SEO tags. */
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <Seo title={title} description={description} path={path} />
      <div className="overline text-ink-400">{overline}</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">{title}</h1>
      <div className="mt-8 space-y-5 text-[0.95rem] leading-relaxed text-ink-700">{children}</div>
    </div>
  );
}

export function AboutPage() {
  return (
    <Prose
      overline="Company"
      title="About N409"
      path="/about"
      description="N409 is an AI-assisted valuation platform producing independent, defensible 409A and business valuations — AI intake, a transparent engine, and credentialed analyst sign-off."
    >
      <p>
        N409 is an AI-assisted valuation platform producing independent, defensible business valuations — IRC
        §409A common-stock valuations for venture-backed companies, and a full family of adjacent fair-value
        opinions across the US, UK, Canada, Australia, and Singapore.
      </p>
      <p>
        We combine three things that rarely live together: an AI ingestion layer that reads your documents and
        drafts the analysis, a transparent quantitative engine that computes every approach with a full audit
        trail, and credentialed analysts who review, adjust, and sign every report.
      </p>
      <p>
        The result is a valuation that is faster and cheaper than a traditional firm, and more defensible than
        a platform add-on — every number in the report traces back to an input, a model, and a reviewer.
      </p>
      <p>
        Questions?{' '}
        <Link to="/contact" className="font-semibold text-bond-600 hover:text-bond-700">
          Get in touch
        </Link>
        .
      </p>
    </Prose>
  );
}

/** Functional contact form (409.ai gap #28) — posts to the public endpoint. */
function ContactForm() {
  const [form, setForm] = useState({ name: '', email: '', company: '', phone: '', message: '' });
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  // Phone is optional here, so this is null for an empty field and only fires
  // on a number that is present but not dialable.
  const phoneError = phoneFieldError(form.phone);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (phoneError) {
      setPhoneTouched(true);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api('/contact', {
        method: 'POST',
        body: {
          name: form.name,
          email: form.email,
          company: form.company || undefined,
          phone: form.phone || undefined,
          message: form.message,
        },
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send your message — please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="rounded-lg border border-bond-200 bg-bond-50 p-6 text-sm text-bond-800">
        <p className="font-semibold">Thanks — your message is in.</p>
        <p className="mt-1.5">
          A member of the team will get back to you by email shortly. In a hurry?{' '}
          <Link to="/register" className="font-semibold text-bond-700 underline">
            Start your valuation
          </Link>{' '}
          in the meantime.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
      noValidate
      aria-label="Contact form"
    >
      <ErrorNote>{error}</ErrorNote>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name">
          <TextInput
            required
            autoComplete="name"
            value={form.name}
            onChange={set('name')}
            placeholder="Ada Lovelace"
          />
        </Field>
        <Field label="Email">
          <TextInput
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={set('email')}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="Company">
          <TextInput
            autoComplete="organization"
            value={form.company}
            onChange={set('company')}
            placeholder="Acme, Inc."
          />
        </Field>
        <Field label="Phone" error={phoneTouched ? phoneError : null}>
          <PhoneInput
            value={form.phone}
            onChange={(phone) => setForm((f) => ({ ...f, phone }))}
            onBlur={() => setPhoneTouched(true)}
          />
        </Field>
      </div>
      <Field label="Message">
        <textarea
          required
          rows={5}
          value={form.message}
          onChange={set('message')}
          placeholder="Tell us what you need and your timeline…"
          className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none"
        />
      </Field>
      <Button type="submit" disabled={busy || !form.name || !form.email || !form.message}>
        {busy ? 'Sending…' : 'Send message'}
      </Button>
    </form>
  );
}

export function ContactPage() {
  const { partnersEmail } = siteConfig();
  return (
    <Prose
      overline="Company"
      title="Contact us"
      path="/contact"
      description="Get in touch with the N409 team — questions about a valuation, pricing, partnerships, or support."
    >
      <p>Questions, concerns, requests — talk to us and we&apos;ll reply by email.</p>
      <ContactForm />
      <div className="rounded-lg border border-paper-300 bg-paper-50 p-6 text-sm">
        <p className="text-ink-600">
          Existing client? Use the in-app support widget from your dashboard — it routes straight to the team
          working on your valuation.
          {/* Addresses are environment-configured; when none is set we don't
              print a mailbox that would bounce (see lib/siteConfig.ts). */}
          {partnersEmail && (
            <>
              {' '}
              For partnerships, reach us at{' '}
              <a
                href={`mailto:${partnersEmail}`}
                className="font-semibold break-words text-bond-600 hover:text-bond-700"
              >
                {partnersEmail}
              </a>
              .
            </>
          )}
        </p>
      </div>
      <p>
        Ready to start instead?{' '}
        <Link to="/register" className="font-semibold text-bond-600 hover:text-bond-700">
          Start your valuation
        </Link>{' '}
        — no credit card required.
      </p>
    </Prose>
  );
}

export function TermsPage() {
  return (
    <Prose
      overline="Legal"
      title="Terms of service"
      path="/terms-of-service"
      description="The terms governing your use of the N409 valuation platform."
    >
      <p className="text-xs text-ink-400">Last updated: July 2026</p>
      <h2 className="font-display text-xl font-semibold text-ink-900">1. Services</h2>
      <p>
        N409 provides business valuation reports and related analysis (&ldquo;Reports&rdquo;). Reports are
        prepared for the purpose stated in the engagement and may not be used for any other purpose without
        our written consent.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">2. Client responsibilities</h2>
      <p>
        You are responsible for the accuracy and completeness of the information you provide, including
        financial statements, capitalization data, and documents imported from connected accounting software.
        Reports rely on that information.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">3. Payment</h2>
      <p>
        Fees are quoted per report and payable before final delivery. Draft review cycles described in your
        engagement are included; additional scope may be quoted separately.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">4. No tax or legal advice</h2>
      <p>
        Reports are valuation opinions, not tax, legal, or investment advice. Consult your own advisors
        regarding your specific situation.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">5. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, our aggregate liability arising out of a Report is limited to
        the fees paid for that Report.
      </p>
    </Prose>
  );
}

export function PrivacyPage() {
  const { privacyEmail } = siteConfig();
  return (
    <Prose
      overline="Legal"
      title="Privacy policy"
      path="/privacy-policy"
      description="How N409 collects, uses, and protects your data, including cookies and analytics."
    >
      <p className="text-xs text-ink-400">Last updated: July 2026</p>
      <h2 className="font-display text-xl font-semibold text-ink-900">What we collect</h2>
      <p>
        Account details (name, email, phone), company information, and the documents and financial data you
        provide or import from connected accounting software — used solely to prepare your valuation.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">How AI processing works</h2>
      <p>
        Documents are processed by AI models to extract structured data. Cap tables are anonymized before any
        AI processing — shareholder names never leave the platform. Extracted values carry their source and
        confidence, and an analyst reviews everything before it reaches your report.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">Sharing</h2>
      <p>
        We do not sell your data. We share it only with service providers necessary to deliver the product
        (payment processing, email delivery, cloud hosting) and when required by law.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">Retention &amp; access</h2>
      <p>
        Engagement records are retained to support the audit-defensibility of delivered reports. You may
        request a copy or deletion of your personal data at any time
        {privacyEmail ? (
          <>
            {' '}
            via{' '}
            <a
              href={`mailto:${privacyEmail}`}
              className="font-semibold break-words text-bond-600 hover:text-bond-700"
            >
              {privacyEmail}
            </a>
          </>
        ) : (
          <>
            {' '}
            through our{' '}
            <Link to="/contact" className="font-semibold text-bond-600 hover:text-bond-700">
              contact form
            </Link>
          </>
        )}
        .
      </p>
    </Prose>
  );
}
