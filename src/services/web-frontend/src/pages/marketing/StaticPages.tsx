import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** About / contact / legal pages (409.ai §22.7) — static content. */

function Prose({ title, overline, children }: { title: string; overline: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <div className="overline text-ink-400">{overline}</div>
      <h1 className="mt-2 font-display text-4xl font-semibold text-ink-900">{title}</h1>
      <div className="mt-8 space-y-5 text-[0.95rem] leading-relaxed text-ink-700">{children}</div>
    </div>
  );
}

export function AboutPage() {
  return (
    <Prose overline="Company" title="About N409">
      <p>
        N409 is an AI-assisted valuation platform producing independent, defensible business
        valuations — IRC §409A common-stock valuations for venture-backed companies, and a full
        family of adjacent fair-value opinions across the US, UK, Canada, Australia, and Singapore.
      </p>
      <p>
        We combine three things that rarely live together: an AI ingestion layer that reads your
        documents and drafts the analysis, a transparent quantitative engine that computes every
        approach with a full audit trail, and credentialed analysts who review, adjust, and sign
        every report.
      </p>
      <p>
        The result is a valuation that is faster and cheaper than a traditional firm, and more
        defensible than a platform add-on — every number in the report traces back to an input, a
        model, and a reviewer.
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

export function ContactPage() {
  return (
    <Prose overline="Company" title="Contact us">
      <p>Questions, concerns, requests — talk to us.</p>
      <div className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <dl className="space-y-4 text-sm">
          <div>
            <dt className="overline text-ink-400">Sales &amp; general</dt>
            <dd className="mt-1 font-semibold text-ink-900">hello@n409.example</dd>
          </div>
          <div>
            <dt className="overline text-ink-400">Support (existing clients)</dt>
            <dd className="mt-1 font-semibold text-ink-900">
              Use the in-app support widget from your dashboard — it routes straight to the team
              working on your valuation.
            </dd>
          </div>
          <div>
            <dt className="overline text-ink-400">Partnerships</dt>
            <dd className="mt-1 font-semibold text-ink-900">partners@n409.example</dd>
          </div>
        </dl>
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
    <Prose overline="Legal" title="Terms of service">
      <p className="text-xs text-ink-400">Last updated: July 2026</p>
      <h2 className="font-display text-xl font-semibold text-ink-900">1. Services</h2>
      <p>
        N409 provides business valuation reports and related analysis (&ldquo;Reports&rdquo;).
        Reports are prepared for the purpose stated in the engagement and may not be used for any
        other purpose without our written consent.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">2. Client responsibilities</h2>
      <p>
        You are responsible for the accuracy and completeness of the information you provide,
        including financial statements, capitalization data, and documents imported from connected
        accounting software. Reports rely on that information.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">3. Payment</h2>
      <p>
        Fees are quoted per report and payable before final delivery. Draft review cycles described
        in your engagement are included; additional scope may be quoted separately.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">4. No tax or legal advice</h2>
      <p>
        Reports are valuation opinions, not tax, legal, or investment advice. Consult your own
        advisors regarding your specific situation.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">5. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, our aggregate liability arising out of a Report is
        limited to the fees paid for that Report.
      </p>
    </Prose>
  );
}

export function PrivacyPage() {
  return (
    <Prose overline="Legal" title="Privacy policy">
      <p className="text-xs text-ink-400">Last updated: July 2026</p>
      <h2 className="font-display text-xl font-semibold text-ink-900">What we collect</h2>
      <p>
        Account details (name, email, phone), company information, and the documents and financial
        data you provide or import from connected accounting software — used solely to prepare your
        valuation.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">How AI processing works</h2>
      <p>
        Documents are processed by AI models to extract structured data. Cap tables are anonymized
        before any AI processing — shareholder names never leave the platform. Extracted values
        carry their source and confidence, and an analyst reviews everything before it reaches your
        report.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">Sharing</h2>
      <p>
        We do not sell your data. We share it only with service providers necessary to deliver the
        product (payment processing, email delivery, cloud hosting) and when required by law.
      </p>
      <h2 className="font-display text-xl font-semibold text-ink-900">Retention &amp; access</h2>
      <p>
        Engagement records are retained to support the audit-defensibility of delivered reports. You
        may request a copy or deletion of your personal data at any time via{' '}
        <span className="font-semibold">privacy@n409.example</span>.
      </p>
    </Prose>
  );
}
