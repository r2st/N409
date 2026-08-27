import { Link } from 'react-router-dom';
import { ApiReference } from '../../components/ApiReference';
import { Seo } from '../../components/Seo';
import { pageMeta } from '../../lib/pageMeta';
import { PARTNER_API, WEBHOOK_EVENTS } from '../../lib/marketingContent';
import { siteConfig } from '../../lib/siteConfig';

/**
 * `/developers` — the public partner API documentation.
 *
 * The reference itself has existed for a long time behind `RequireAuth` at
 * `/partner/api-docs`, which is the wrong side of the door: a platform engineer
 * evaluating whether to integrate cannot read the docs without an account, and
 * an API nobody can read before signing up is one nobody proposes to their
 * team. The docs endpoint it renders from was already unauthenticated.
 *
 * The concepts below are static because a crawler and a first-time reader both
 * need them without running JavaScript; the endpoint table is fetched live from
 * the server's own route registry, so it cannot drift from the API.
 */

function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <div className="mt-4">
      {label && <div className="overline mb-1.5 text-xs text-ink-400">{label}</div>}
      <pre className="overflow-x-auto overscroll-x-contain rounded-lg bg-ink-900 px-4 py-3 font-mono text-xs leading-relaxed text-paper-50">
        <code>{children}</code>
      </pre>
    </div>
  );
}

const QUICKSTART = `# 1. Confirm the key works — and which key it is
curl -H "Authorization: Bearer $N409_API_KEY" \\
  https://<your-host>${PARTNER_API.prefix}/me

# 2. Create an engagement. external_id is your own handle on it, so a
#    create whose response you never receive is still findable.
curl -X POST -H "Authorization: Bearer $N409_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"kind":"409a","company_name":"Acme, Inc.","external_id":"deal-4821"}' \\
  https://<your-host>${PARTNER_API.prefix}/valuations

# 3. Attach the supporting documents
curl -X POST -H "Authorization: Bearer $N409_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"filename":"cap-table.xlsx","kind":"cap_table","content_base64":"..."}' \\
  https://<your-host>${PARTNER_API.prefix}/valuations/$ID/documents

# 4. Hand it over. Idempotent — retry freely.
curl -X POST -H "Authorization: Bearer $N409_API_KEY" \\
  https://<your-host>${PARTNER_API.prefix}/valuations/$ID/submit

# Lost the id? Look it up by yours.
curl -H "Authorization: Bearer $N409_API_KEY" \\
  "https://<your-host>${PARTNER_API.prefix}/valuations?external_id=deal-4821"`;

const VERIFY = `import hmac, hashlib

def verify(secret: str, body: bytes, header: str) -> bool:
    """header is the value of ${PARTNER_API.signatureHeader}: sha256=<hex>"""
    expected = "sha256=" + hmac.new(
        secret.encode(), body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, header)`;

export function DevelopersPage() {
  const { partnersEmail } = siteConfig();
  return (
    <div>
      <Seo {...pageMeta('/developers')!} />

      <section className="ledger-grid bg-chrome-900 text-chrome-fg">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="overline mb-4 text-brass-400">Developers</div>
          <h1 className="max-w-3xl font-display text-4xl leading-tight font-medium sm:text-5xl">
            The partner API
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-chrome-dim">
            Create valuation engagements from your own product, upload the supporting documents, follow the
            state, and pull the signed report back. Everything the app does, over REST.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              to="/partners"
              className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-bond-fg shadow-lift transition-colors hover:bg-bond-700"
            >
              Request API access
            </Link>
            <a
              href={PARTNER_API.openApiUrl}
              className="rounded-md border border-chrome-600 px-6 py-3 text-sm font-semibold text-chrome-fg transition-colors hover:border-chrome-faint"
            >
              OpenAPI 3.1 document
            </a>
          </div>
        </div>
      </section>

      {/* Quickstart */}
      <section className="mx-auto max-w-4xl px-5 py-16">
        <div className="overline text-brass-600">Quickstart</div>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">Your first call</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-600">
          Every request carries a bearer key issued to your organisation. Keys are shown once at issue and are
          stored only as a hash, so a lost key is replaced rather than recovered — and they belong
          server-side, never in a browser or a mobile binary.
        </p>
        <CodeBlock label="curl">{QUICKSTART}</CodeBlock>
        <p className="mt-4 text-sm leading-relaxed text-ink-600">
          Session tokens from the web app are rejected on this API: a partner integration authenticates as the
          organisation, not as a person who might leave it.
        </p>
      </section>

      {/* Concepts */}
      <section className="border-t border-paper-300 bg-surface">
        <div className="mx-auto max-w-4xl px-5 py-16">
          <div className="overline text-brass-600">Concepts</div>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">
            Four things worth knowing before you build
          </h2>

          <div className="mt-8 space-y-10">
            <article>
              <h3 className="font-display text-lg font-semibold text-ink-900">Idempotency</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                Send an{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">Idempotency-Key</code> on
                any POST. A retry with the same key replays the stored first response — flagged with{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">
                  x-idempotent-replay: true
                </code>{' '}
                — instead of creating a second engagement. The same key with a <em>different</em> body is
                refused as the client bug it is, rather than quietly returning the earlier result. Keys are
                scoped to your organisation, so two partners cannot collide, and only successful responses are
                stored: a validation failure should be corrected and retried under the same key.
              </p>
            </article>

            <article>
              <h3 className="font-display text-lg font-semibold text-ink-900">Webhooks</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                Register an HTTPS endpoint and we push events to it rather than making you poll. The signing
                secret (
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">
                  {PARTNER_API.webhookSecretPrefix}…
                </code>
                ) is returned once, at registration.
              </p>
              <ul className="mt-4 space-y-2 text-sm text-ink-700">
                {WEBHOOK_EVENTS.map((event) => (
                  <li key={event.name} className="flex flex-wrap gap-2">
                    <code className="rounded bg-paper-200 px-1.5 py-0.5 font-mono text-xs font-semibold">
                      {event.name}
                    </code>
                    <span className="text-ink-600">{event.description}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-sm leading-relaxed text-ink-600">
                Each delivery carries{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">
                  {PARTNER_API.signatureHeader}
                </code>{' '}
                — an HMAC-SHA256 over the exact bytes of the request body, as{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">sha256=&lt;hex&gt;</code>{' '}
                — alongside{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">
                  {PARTNER_API.eventHeader}
                </code>{' '}
                and{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">
                  {PARTNER_API.deliveryHeader}
                </code>
                . Compare it in constant time, and against the raw body rather than a re-serialised one.
              </p>
              <CodeBlock label="python">{VERIFY}</CodeBlock>
              <p className="mt-4 text-sm leading-relaxed text-ink-600">
                A failed delivery is retried on a fixed ladder — {PARTNER_API.retryLadder.join(', ')} after
                the first attempt, {PARTNER_API.retryLadder.length + 1} attempts in total — with jitter so a
                receiver coming back up is not hit by every queued delivery at once. A{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">Retry-After</code> you
                send overrides the ladder for that attempt.
              </p>
            </article>

            <article>
              <h3 className="font-display text-lg font-semibold text-ink-900">Rate limits</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                Per API key, with the current window returned on every response in{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">x-ratelimit-limit</code>,{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">
                  x-ratelimit-remaining
                </code>{' '}
                and{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">x-ratelimit-reset</code>.
                The live figure is in the reference below. Back off on a 429 rather than retrying immediately
                — the window is short.
              </p>
            </article>

            <article>
              <h3 className="font-display text-lg font-semibold text-ink-900">Errors</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-600">
                Failures come back as RFC 9457 problem documents (
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">
                  application/problem+json
                </code>
                ) with a <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">type</code>, a{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">title</code> and a
                human-readable{' '}
                <code className="rounded bg-paper-200 px-1 py-0.5 font-mono text-xs">detail</code> — one shape
                to handle rather than a different error body per endpoint. An id belonging to another
                organisation is <strong>not found</strong> rather than forbidden: a partner cannot confirm
                that another partner’s engagement exists.
              </p>
            </article>
          </div>
        </div>
      </section>

      {/* The live reference */}
      <section className="mx-auto max-w-4xl px-5 py-16">
        <div className="overline text-brass-600">Reference</div>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink-900">Every endpoint</h2>
        <p className="mt-3 mb-2 text-sm leading-relaxed text-ink-600">
          Rendered from the server’s own route registry, so it describes the API this deployment is actually
          running.
        </p>
        <ApiReference />
      </section>

      <section className="ledger-grid border-t border-chrome-800 bg-chrome-900 text-chrome-fg">
        <div className="mx-auto max-w-4xl px-5 py-16 text-center">
          <h2 className="font-display text-3xl font-semibold">Get an API key</h2>
          <p className="mx-auto mt-4 max-w-xl text-chrome-dim">
            Keys are issued to partner organisations.{' '}
            {partnersEmail ? (
              <>
                Tell us what you are building at{' '}
                <a
                  href={`mailto:${partnersEmail}`}
                  className="font-semibold break-words text-brass-400 hover:text-brass-300"
                >
                  {partnersEmail}
                </a>
                .
              </>
            ) : (
              'Tell us what you are building and we will get you set up.'
            )}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link
              to="/partners"
              className="rounded-md bg-bond-600 px-6 py-3 text-sm font-semibold text-bond-fg shadow-lift transition-colors hover:bg-bond-700"
            >
              Partner programme
            </Link>
            <Link
              to="/contact"
              className="rounded-md border border-chrome-600 px-6 py-3 text-sm font-semibold text-chrome-fg transition-colors hover:border-chrome-faint"
            >
              Contact us
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
