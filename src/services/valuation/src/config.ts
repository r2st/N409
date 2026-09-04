import { z } from 'zod';
import { EMAIL_MAX_ATTEMPTS } from './domain/emailRetry.js';

/**
 * An optional AES-256 key from the environment: 64 hex chars, or base64 that
 * decodes to 32 bytes.
 *
 * Validated here so a mistyped key is a refusal to boot rather than a 500 on
 * the first upload. `parseKey` in crypto/envelope.ts throws the same way, but
 * it only runs when something is actually encrypted — which for the retired
 * `_PREVIOUS` keys means "when a value that needs it is read", i.e. possibly
 * never, and certainly not while the operator is still watching the deploy.
 */
const atRestKey = () =>
  z
    .string()
    .optional()
    .refine(
      (raw) =>
        raw === undefined ||
        (/^[0-9a-fA-F]{64}$/.test(raw) ? true : Buffer.from(raw, 'base64').length === 32),
      { message: 'must be 32 bytes (64 hex chars or base64)' },
    );

/**
 * A TCP port from the environment: 1–65535, integral, and named in the message.
 *
 * `z.coerce.number()` reads a bare `PORT=` as 0, which Node reads as "any free
 * one" — unbounded, this schema accepted that and the service came up healthy
 * on a port nothing dials. -1 and 70000 used to pass here too and die at the
 * socket with a bare ERR_SOCKET_BAD_PORT that names neither the variable nor
 * its value. `@n409/shared`'s `listenPort` is the same rule for the two
 * services that have no schema of their own.
 *
 * It is a function rather than a comment on `PORT` because `PORT` was not the
 * only one: `SMTP_PORT` sat two lines below the comment claiming every number
 * here is bounded, and was not. Its failure is the quieter of the two — the
 * port is not dialled until an email is sent, so a mistyped one boots clean,
 * passes readiness, and then fails every message into the outbox as a delivery
 * error, for as long as nobody reads the outbox.
 *
 * `zeroMeans` is what the operator needs to know and the only part that is not
 * the same for both: a listen port of 0 binds something, a dial port of 0
 * reaches nothing.
 */
const portParam = (name: string, fallback: number, zeroMeans: string) =>
  z.coerce
    .number()
    .int()
    .min(1, `${name} must be between 1 and 65535 — 0 (or a bare \`${name}=\`) ${zeroMeans}`)
    .max(65535, `${name} must be between 1 and 65535`)
    .default(fallback);

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: portParam('PORT', 3001, 'binds a random ephemeral port'),
  DATABASE_URL: z.string().min(1).default('postgres://n409:n409_dev@localhost:5432/n409_dev'),
  LOG_LEVEL: z.string().default('info'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_ISSUER: z.string().default('n409'),
  // Session lifetime, and the session cookie's `maxAge` with it (auth/cookies.ts).
  //
  // Bounded at both ends, which every other number in this file already is and
  // this one was not (round 74). The floor turns the unit confusion into a
  // refused boot rather than a platform where every session dies mid-request:
  // `JWT_TTL_SECONDS=8`, meaning hours, is the obvious typo and it used to be
  // accepted silently. The ceiling is a week, because the only thing that ends
  // a session here besides `session_epoch` is this expiry, and the sessions in
  // question read cap tables and 409A conclusions.
  JWT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60, 'JWT_TTL_SECONDS is in seconds; a session shorter than a minute is a typo')
    .max(604800, 'JWT_TTL_SECONDS must not exceed 7 days')
    .default(28800),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  // M1 core pipeline — internal service URLs + document storage
  AI_URL: z.string().url().default('http://127.0.0.1:3002'),
  ENGINE_URL: z.string().url().default('http://127.0.0.1:3003'),
  /**
   * The report service, which renders the 409A PDF so that this process does
   * not (`clients/reportRender.ts`).
   *
   * Defaulted rather than left optional, and that is the decision worth
   * recording. A pdfkit render is half a second of blocked event loop on the
   * deployed box, the unit that exists to absorb it has been running and idle
   * since M2, and a fix that only takes effect once somebody remembers to add a
   * line to `/opt/N409/.env` is a fix that stays off — config living only on
   * the host is this platform's recurring defect, not a hypothetical one. The
   * loopback default means a redeploy turns it on with nothing to remember and
   * no systemd unit to reinstall.
   *
   * Safe to default because there is nothing to lose by trying: every failure
   * of the delegated path — refused connection, timeout, rejection, an answer
   * that is not a PDF — falls back to rendering here, which is what every
   * commit before this one did unconditionally.
   *
   * The empty string is the off switch, which is why this is a union rather
   * than a plain `.url()`: `REPORT_URL=` has to mean "render in-process" rather
   * than fail the boot, so an operator can take the offload out of the path
   * during an incident with an edit and a restart.
   */
  REPORT_URL: z.union([z.literal(''), z.string().url()]).default('http://127.0.0.1:3004'),
  // Shared secret sent as X-Internal-Token on every AI/engine call (audit
  // B-1 P0). Both Python services enforce it when set; leave unset in local
  // dev where the services also skip the check.
  INTERNAL_SERVICE_TOKEN: z.string().optional(),
  DOCUMENTS_DIR: z.string().min(1).default('./data/documents'),
  /*
   * Where `infra/backup/pg-backup.sh` writes its dumps, read — never written —
   * so `/metrics` can say whether the nightly backup actually ran (R428).
   *
   * The same literal the two backup units set, because the alternative is the
   * config drift this estate keeps rediscovering: a value that lives only on
   * the box, in two files, that nothing compares. Empty switches the gauges to
   * `n409_backup_watched 0`, which is a deployment saying "backups are not
   * here" out loud rather than by being silent — see `observability/backups.ts`
   * for why absence is never the answer for a gauge-backed rule.
   */
  BACKUP_ROOT: z.string().default('/opt/n409-backups'),
  // Encrypt document blobs at rest with AES-256-GCM (audit B-5 P1). 32 bytes as
  // 64 hex chars or base64; unset leaves blobs in the clear (dev). Legacy
  // plaintext blobs are still readable after the key is enabled.
  DOCUMENTS_ENCRYPTION_KEY: atRestKey(),
  // The retired key, honoured on read so DOCUMENTS_ENCRYPTION_KEY can be
  // rotated without stranding every blob written before the rotation. See
  // crypto/envelope.ts and tools/rotate-at-rest-keys.mjs; drop it once that
  // tool reports nothing left to re-seal.
  DOCUMENTS_ENCRYPTION_KEY_PREVIOUS: atRestKey(),
  // At-rest key for TOTP seeds and for the third-party OAuth credentials in
  // accounting_connections / hris_connections / cap_table_connections and the
  // partner webhook signing secrets. Each falls back to the next when unset —
  // CONNECTION_ENCRYPTION_KEY, then MFA_ENCRYPTION_KEY, then
  // DOCUMENTS_ENCRYPTION_KEY — so one configured key covers all three
  // subsystems. Declared here so `loadConfig` reports a wrong-length key at
  // boot rather than at the first write.
  MFA_ENCRYPTION_KEY: atRestKey(),
  MFA_ENCRYPTION_KEY_PREVIOUS: atRestKey(),
  CONNECTION_ENCRYPTION_KEY: atRestKey(),
  CONNECTION_ENCRYPTION_KEY_PREVIOUS: atRestKey(),
  // Auto-pipeline on upload (extraction → param fill → draft calculation).
  // 'off' disables it globally; per-valuation opt-out is valuations.auto_pipeline.
  AUTO_PIPELINE: z.enum(['on', 'off']).default('on'),
  // Max auto-pipeline orchestrations to run concurrently in-process; excess
  // uploads keep a 'queued' run row until a slot frees (B-3 §auto-pipeline).
  AUTO_PIPELINE_MAX_CONCURRENT: z.coerce.number().int().min(1).default(4),
  // A run stuck in an active status longer than this is failed by the reaper
  // (recovers orphaned runs after a restart). 0 disables the sweep.
  AUTO_PIPELINE_STALE_MINUTES: z.coerce.number().int().min(0).default(30),
  // Auto email workflows — 'smtp' delivers through SMTP_HOST; 'log' records
  // delivery in the service log (outbox rows track status either way); 'off'
  // only queues. 'smtp' without SMTP_HOST falls back to 'log'.
  EMAIL_MODE: z.enum(['smtp', 'log', 'off']).default('log'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: portParam('SMTP_PORT', 587, 'is not a relay to dial'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('N409 Valuations <no-reply@n409.local>'),
  // SMS drip campaigns (§15.6) — 'log' records delivery in the service log
  // (a real provider adapter slots into buildEmailTransports); 'off' only
  // queues outbox rows.
  SMS_MODE: z.enum(['log', 'off']).default('log'),
  // Drip campaign scan interval in minutes; 0 disables the interval (the
  // POST /admin/auto-emails/run endpoint still works).
  AUTO_EMAIL_SCAN_MINUTES: z.coerce.number().int().min(0).default(15),
  // Outbox rows left 'failed' by a transient transport error (SMTP hiccup,
  // connection refused) otherwise sit forever — nothing else revisits them.
  // 0 disables the sweep. Rows that have failed EMAIL_RETRY_MAX_ATTEMPTS
  // times are left alone (treated as a real, non-transient failure).
  //
  // The scan is a poll, not the schedule: when a failed row is next eligible is
  // EMAIL_RETRY_BACKOFF_MINUTES on the row itself (0159), so a scan interval
  // longer than a ladder step delays that step rather than skipping it.
  EMAIL_RETRY_SCAN_MINUTES: z.coerce.number().int().min(0).default(30),
  // The initial attempt plus one per backoff step. Was 5 with no ladder behind
  // it, which spent every attempt inside one outage; the default now tracks the
  // ladder's length so the last attempt lands ~8.5 hours out. Raising it holds
  // at the longest step rather than adding new ones.
  EMAIL_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(EMAIL_MAX_ATTEMPTS),

  // Shared secret for POST /api/v1/webhooks/email/:provider (migration 0163).
  // Unset — the default, and what this deployment runs — means the route is not
  // registered at all: an endpoint accepting unsigned delivery claims would let
  // anyone mark a named client's address as bounced, which suppresses it. That
  // is a denial of service against one client, from the internet, with no
  // account. Bounce tracking does not depend on it; a relay that rejects a
  // recipient in-band is classified without any provider involved.
  EMAIL_WEBHOOK_SECRET: z.string().min(32, 'EMAIL_WEBHOOK_SECRET must be at least 32 chars').optional(),
  // Partner webhook delivery retries (migration 0103). The shortest backoff
  // step is one minute, so a slower scan than that just delays the first retry
  // — it cannot lose it. 0 disables the sweep; POST /admin/webhooks/retry
  // still works.
  WEBHOOK_RETRY_SCAN_MINUTES: z.coerce.number().int().min(0).default(1),
  // Job-queue alert sweep (design §17.1 item 13). Five minutes is short enough
  // that a stopped queue is noticed within one, and long enough that the
  // cheapest threshold here (60 minutes) is not re-evaluated pointlessly. 0
  // disables the interval; POST /admin/jobs/alerts/scan still works, which is
  // how a deployment that runs the sweep from cron instead turns this off.
  JOB_ALERT_SCAN_MINUTES: z.coerce.number().int().min(0).default(5),
  // A partner chooses the webhook URL and this service fetches it, so a target
  // inside the network is an SSRF primitive (see domain/partnerWebhooks.ts).
  // Registration refuses one and delivery re-checks the resolved address. Set
  // this only for local development, where the receiver really is on
  // 127.0.0.1; it defaults off so an unset production environment is the safe
  // one.
  WEBHOOK_ALLOW_PRIVATE_TARGETS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Stripe payment processing (remaining-gaps §3 #1). Routes 503 when unset.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // The subscription/invoice webhook lives at its own path
  // (/api/v1/billing/webhook) from the payment one (/api/v1/stripe/webhook),
  // and Stripe issues a *separate* signing secret per registered endpoint —
  // you cannot tell it to reuse one. So a single STRIPE_WEBHOOK_SECRET can
  // only ever verify one of the two: register both and whichever secret is not
  // in the env answers every delivery with `400 Invalid Stripe signature`.
  // Nothing surfaces that but the Stripe dashboard's failed-delivery list, and
  // the events being dropped are the ones that record a subscription starting
  // and an invoice being paid.
  //
  // Set this to the billing endpoint's own signing secret. Left unset it falls
  // back to STRIPE_WEBHOOK_SECRET, so a deployment that registers one endpoint,
  // or that has not enabled subscriptions at all, needs no new configuration.
  STRIPE_BILLING_WEBHOOK_SECRET: z.string().optional(),
  // Base URL the browser lands on after Stripe checkout (the web frontend).
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  // The domain white-label tenants live under, e.g. 'app.409.ai' — a request
  // for acme.app.409.ai then resolves the partner with subdomain 'acme'
  // (migration 0106). Unset means no host-based tenant resolution at all, which
  // is the right default: without it, any Host header a client sends would be
  // read as a tenant claim.
  APP_BASE_DOMAIN: z.string().optional(),
  // Accounting integrations (§23) — each provider activates when its OAuth
  // client id + secret are both set; unset providers show as "not configured".
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  QUICKBOOKS_CLIENT_ID: z.string().optional(),
  QUICKBOOKS_CLIENT_SECRET: z.string().optional(),
  FRESHBOOKS_CLIENT_ID: z.string().optional(),
  FRESHBOOKS_CLIENT_SECRET: z.string().optional(),
  NETSUITE_CLIENT_ID: z.string().optional(),
  NETSUITE_CLIENT_SECRET: z.string().optional(),
  SAGE_CLIENT_ID: z.string().optional(),
  SAGE_CLIENT_SECRET: z.string().optional(),
  WAVE_CLIENT_ID: z.string().optional(),
  WAVE_CLIENT_SECRET: z.string().optional(),
  // Cap-table sync (feature 4) — Carta / Pulley OAuth, same activation rule.
  CARTA_CLIENT_ID: z.string().optional(),
  CARTA_CLIENT_SECRET: z.string().optional(),
  PULLEY_CLIENT_ID: z.string().optional(),
  PULLEY_CLIENT_SECRET: z.string().optional(),
  // HRIS/payroll (feature 11) — Rippling / Gusto / Deel OAuth.
  RIPPLING_CLIENT_ID: z.string().optional(),
  RIPPLING_CLIENT_SECRET: z.string().optional(),
  GUSTO_CLIENT_ID: z.string().optional(),
  GUSTO_CLIENT_SECRET: z.string().optional(),
  DEEL_CLIENT_ID: z.string().optional(),
  DEEL_CLIENT_SECRET: z.string().optional(),
  // General per-user / per-org request throttling on the authenticated API
  // surface (improvement 5 — beyond the existing per-endpoint auth/partner
  // limiters). 0 disables. Only enforced in production — see buildApp.
  SESSION_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(300),
  SESSION_RATE_LIMIT_ORG_PER_MIN: z.coerce.number().int().min(0).default(1500),
  // The partner API's own per-organisation ceiling, charged across every key
  // the organisation holds. Unlike the two above this is enforced in every
  // environment, because the per-key limit it backstops always is: a per-key
  // limit on a surface where keys are self-service is not a ceiling on the
  // caller. 0 disables it. See PARTNER_API_RATE_LIMIT_ORG.
  PARTNER_API_RATE_LIMIT_ORG_PER_MIN: z.coerce.number().int().min(0).default(600),
  // Per-user budget, in cost units per minute, for the expensive routes
  // classified in domain/requestCost.ts (renders, exports, engine runs, AI
  // jobs). Roughly: 20 PDF renders, 8 evidence bundles or 8 AI jobs a minute.
  // 0 disables. Production-only, like the counters above.
  HEAVY_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(200),
  // A statement at or over this many ms gets its own `slow query` warn line
  // (db/queryStats.ts). 200ms is well under the 15s statement_timeout and above
  // where a healthy indexed query on this schema lands, so the log names
  // regressions rather than narrating normal traffic. The aggregate at
  // /api/v1/admin/db/slow-queries counts every statement regardless — this
  // threshold only governs the per-statement line. 0 logs everything.
  DB_SLOW_QUERY_MS: z.coerce.number().int().min(0).default(200),
  // How often the pool-health sampler runs (db/poolHealth.ts). The sample is a
  // synchronous scan of a map bounded by the pool's `max`, so this is cheap
  // enough to run often — and both conditions it looks for (a leaked
  // connection, an exhausted pool) get worse the longer they go unreported.
  // 0 disables the sampler; the gauges it feeds keep working either way.
  DB_POOL_SAMPLE_SECONDS: z.coerce.number().int().min(0).default(15),
  // A connection checked out for longer than this is reported as a suspected
  // leak, with the stack that acquired it. Comfortably above the 15s
  // statement_timeout: a long transaction running several statements is not a
  // leak, and a detector that cries wolf is a detector somebody turns off.
  DB_LEAK_AFTER_MS: z.coerce.number().int().min(1_000).default(60_000),
  // How long the pool must be continuously saturated — every client checked
  // out, nothing idle, callers queued — before it is called exhausted. The
  // dwell is what separates a saturated pool from a merely busy one: at any
  // instant a healthy service under load has callers waiting.
  DB_EXHAUSTED_AFTER_MS: z.coerce.number().int().min(0).default(5_000),
  // Wall-clock budget for the boot-time dependency probes (shared/startup.ts).
  // Long enough to cover a database that is still starting after a host reboot,
  // short enough that a genuinely absent one fails the unit while systemd still
  // has restarts left rather than after a five-minute stall.
  STARTUP_DEPENDENCY_TIMEOUT_MS: z.coerce.number().int().min(0).default(60_000),
  // How often failed auto-pipeline runs whose retry is due are re-queued
  // (migration 0161). 0 disables the sweep, which leaves a transiently-failed
  // run needing a manual trigger — the behaviour before 0161.
  PIPELINE_RETRY_SCAN_MINUTES: z.coerce.number().int().min(0).default(5),
  // Antivirus for uploaded documents (documents/virusScan.ts). Unset means no
  // scanning, which is the status quo — a scan nobody has deployed clamd for
  // must not stop the service booting.
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),
  // What an unreachable scanner means once one *is* configured. Fail-closed by
  // default: a control that silently stops working is worse than no control,
  // because the uploads that arrive while it is down are the ones nobody will
  // go back and re-check. Set 'false' where upload availability outranks it.
  VIRUS_SCAN_FAIL_CLOSED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof Env>;

/**
 * Well-known example / placeholder secrets that ship in the repo. They pass the
 * length check but are publicly known, so anyone could forge admin JWTs if one
 * reached production (audit B-1 P1). Compared case-insensitively.
 */
export const KNOWN_EXAMPLE_JWT_SECRETS: readonly string[] = [
  'dev-only-secret-change-me-0123456789abcdef',
  'ci-only-secret-0123456789abcdef-0123456789',
  'integration-test-secret-0123456789abcdef',
];

/** Distinct characters as a crude entropy proxy — "aaaa…aaaa" must not pass. */
function looksLowEntropy(secret: string): boolean {
  return new Set(secret).size < 8;
}

/**
 * Variables whose *default* is a local-development value, and which therefore
 * have to be set explicitly once NODE_ENV says production.
 *
 * Their defaults exist so `npm run dev` needs no .env, and that convenience is
 * exactly what makes them dangerous deployed: nothing errors, so nothing says
 * they were never configured.
 *
 * `PUBLIC_BASE_URL` is the one that hurt. It is the origin of every link this
 * service emails — password reset, email verification, invitations, the client
 * intake link, board-approval signing, unsubscribe — and of the URLs Stripe
 * returns a payer to. Left unset, all of them are minted against
 * `http://localhost:3000`, which resolves for nobody. The service starts
 * healthy, the outbox reports every message delivered, and the failure surfaces
 * as users saying the reset email "doesn't work" — with the token spent, and
 * no self-serve way back in.
 *
 * `DATABASE_URL` is here for a duller reason: its default names a database
 * called `n409_dev` with a password published in this repo. Reaching migrate()
 * and failing to connect is a survivable way to find that out, but "connection
 * refused" is a much worse account of the problem than this is — and on a host
 * that happens to run a local Postgres it is not the failure you get.
 *
 * Only checked in production, and only for presence: a deployment that
 * deliberately points at localhost (a sidecar database, a reverse proxy) sets
 * the variable and is believed.
 */
const REQUIRED_IN_PRODUCTION = ['DATABASE_URL', 'PUBLIC_BASE_URL'] as const;

/**
 * Settings that are only meaningful as a set, and what a half-set one does.
 *
 * Each of these subsystems activates on one variable and *works* on another, so
 * setting the first without the second does not disable the feature — it turns
 * the feature on with its back half missing. Nothing errors, because every one
 * of them was deliberately written to degrade rather than crash when it is not
 * configured at all, and "not configured at all" is what half of a set looks
 * like to the half that is checking.
 *
 * Checked in production only, for the same reason as {@link REQUIRED_IN_PRODUCTION}:
 * the partial state is a normal step on the way to a working local setup, and a
 * developer who has pasted in one key and not yet the other is mid-sentence.
 * Deployed, it is a subsystem nobody will be told is broken.
 */
function halfConfigured(config: Config, env: NodeJS.ProcessEnv): string[] {
  const faults: string[] = [];

  // The expensive one. `checkoutAvailableTo` (routes/payments.ts) decides
  // whether a client may be charged from STRIPE_SECRET_KEY alone, and
  // fulfilment — marking the payment succeeded, releasing the engagement,
  // capturing the receipt — happens nowhere but the webhook, which answers 503
  // without STRIPE_WEBHOOK_SECRET. So this pairing sells a valuation, takes the
  // money, and never delivers: Stripe retries a 503 for three days and gives
  // up, our payments row stays 'pending' forever, and the only party who knows
  // a charge succeeded is Stripe. The reverse (a webhook secret with no API
  // key) is the safe half — checkout is simply unavailable — and is what the
  // test suite runs with, so it is deliberately not a fault.
  if (config.STRIPE_SECRET_KEY && !config.STRIPE_WEBHOOK_SECRET) {
    faults.push(
      'STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not — checkout would take money ' +
        'that nothing is able to fulfil, because the webhook is the only thing that marks a ' +
        'payment succeeded',
    );
  }

  // `buildEmailTransports` falls back to the log transport when EMAIL_MODE=smtp
  // and no host is given. That is right in development, where the log is where
  // you read the reset link. Deployed it means every password reset, invitation,
  // verification and client notification is written to stdout and reported
  // delivered, with the outbox agreeing.
  if (config.EMAIL_MODE === 'smtp' && !config.SMTP_HOST) {
    faults.push(
      'EMAIL_MODE=smtp but SMTP_HOST is unset — every message would fall back to the log ' +
        'transport and be recorded as delivered',
    );
  }

  // Google sign-in needs all three; app.ts constructs the client only when it
  // has them, and `GET /auth/providers` then tells the SPA not to draw the
  // button. Users who signed up through Google have no password to fall back
  // on, so a missing redirect URI locks them out with no self-serve way back.
  const google = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const;
  const googleSet = google.filter((name) => env[name]);
  if (googleSet.length > 0 && googleSet.length < google.length) {
    faults.push(
      `Google sign-in is half-configured (${google.filter((n) => !env[n]).join(', ')} unset) — ` +
        'the sign-in button would silently disappear and Google-only accounts could not log in',
    );
  }

  return faults;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const config = parsed.data;

  // Fail closed on boot in production if the signing key is a known example or
  // trivially low-entropy — a publicly known key is a full auth bypass.
  if (config.NODE_ENV === 'production') {
    const unset = REQUIRED_IN_PRODUCTION.filter((name) => !env[name]);
    if (unset.length > 0) {
      throw new Error(
        `Invalid configuration: ${unset.join(', ')} must be set in production — ` +
          'the development defaults point at localhost and would be used silently',
      );
    }

    const secret = config.JWT_SECRET;
    const denied = KNOWN_EXAMPLE_JWT_SECRETS.some((known) => known.toLowerCase() === secret.toLowerCase());
    if (denied || looksLowEntropy(secret)) {
      throw new Error(
        'Invalid configuration: JWT_SECRET is a known example or low-entropy value — ' +
          'set a unique random secret in production (openssl rand -hex 32)',
      );
    }

    const faults = halfConfigured(config, env);
    if (faults.length > 0) {
      throw new Error(`Invalid configuration: ${faults.join('; ')}`);
    }
  }
  return config;
}
