import type { Config } from '../config.js';

/**
 * The subsystems that are allowed to be off, and what the platform silently
 * does instead.
 *
 * WHY THIS EXISTS. `halfConfigured` (config.ts) refuses to start in production
 * when a subsystem is configured *half* way, because half is the state that
 * looks working and is not. It says nothing about a subsystem that is off
 * altogether, and that is correct — every one of these degrades deliberately
 * rather than crashing, which is what makes a local checkout runnable and a
 * staging box cheap.
 *
 * The cost is that the only record of the decision is one `log.info` at boot.
 * `CLAMAV_HOST unset — uploaded documents are not virus scanned` was written to
 * stdout once, weeks ago, on a box nobody was watching; it is now the honest
 * answer to a question — "are the files our clients upload scanned?" — that
 * nothing on this platform could be asked. The same is true of payments, of
 * blob encryption, and of whether an email that the outbox reports delivered
 * went anywhere.
 *
 * WHAT THIS IS NOT. It does not decide anything and nothing branches on it.
 * Every consumer here already reads the config directly at the point of use;
 * a second definition that could disagree with the first would be worse than
 * no answer. This reads the same config and *describes* it.
 *
 * SEVERITY IS ABOUT THE SILENCE, not about the feature. `payments` off is
 * loud — checkout is simply unavailable and a client sees that — so it is
 * `visible`. `virus_scanning` off is silent: the upload succeeds, the file is
 * stored, the file is served back, and nothing anywhere says it was never
 * looked at. That asymmetry is the whole point of ranking them.
 */
export type CapabilitySeverity = 'silent' | 'visible';

export interface OptionalCapability {
  /** Stable key — the thing a dashboard or an alert rule matches on. */
  key: string;
  label: string;
  /** True when every variable in `env` is set. */
  configured: boolean;
  /** The variables that turn it on. All of them, not the first one. */
  env: string[];
  /**
   * What happens instead while it is off. Present whether or not it is off:
   * an operator reading this configured is entitled to know what they would
   * be back to.
   */
  fallback: string;
  /**
   * `silent` — the platform behaves as though nothing were missing, and no
   * user or log line downstream says otherwise.
   * `visible` — the absence shows up on its own, in the product or in an
   * error a caller receives.
   */
  severity: CapabilitySeverity;
}

/** The subset of config this reads. Narrowed so a test can build one by hand. */
export type CapabilityConfig = Pick<
  Config,
  | 'CLAMAV_HOST'
  | 'DOCUMENTS_ENCRYPTION_KEY'
  | 'EMAIL_MODE'
  | 'SMTP_HOST'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_WEBHOOK_SECRET'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'GOOGLE_REDIRECT_URI'
>;

const set = (v: string | undefined): boolean => typeof v === 'string' && v.length > 0;

export function optionalCapabilities(config: CapabilityConfig): OptionalCapability[] {
  return [
    {
      key: 'virus_scanning',
      label: 'Upload virus scanning',
      configured: set(config.CLAMAV_HOST),
      env: ['CLAMAV_HOST'],
      fallback:
        'Uploads are accepted, stored and served back without being scanned. The magic-byte ' +
        'check still refuses a file whose bytes contradict its name, which is a different ' +
        'question from whether the file is hostile.',
      severity: 'silent',
    },
    {
      key: 'document_encryption',
      label: 'Document encryption at rest',
      configured: set(config.DOCUMENTS_ENCRYPTION_KEY),
      env: ['DOCUMENTS_ENCRYPTION_KEY'],
      fallback:
        'Document blobs are written to DOCUMENTS_DIR in the clear. Anyone with the filesystem ' +
        'has the cap tables. Blobs already encrypted stay readable after the key is set, so ' +
        'turning it on is not a migration.',
      severity: 'silent',
    },
    {
      key: 'email_delivery',
      label: 'Outbound email',
      // `EMAIL_MODE=log` is a decision; `EMAIL_MODE=smtp` with no host is the
      // same decision made by accident, and `halfConfigured` already refuses to
      // boot on it in production. Both read as "not delivering" here.
      configured: config.EMAIL_MODE === 'smtp' && set(config.SMTP_HOST),
      env: ['EMAIL_MODE=smtp', 'SMTP_HOST'],
      fallback:
        'Every message — password resets, invitations, verification, client reminders — is ' +
        'written to the log and recorded in the outbox as delivered. The outbox agrees with ' +
        'itself, which is what makes this one silent.',
      severity: 'silent',
    },
    {
      key: 'payments',
      label: 'Stripe checkout and fulfilment',
      configured: set(config.STRIPE_SECRET_KEY) && set(config.STRIPE_WEBHOOK_SECRET),
      env: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
      fallback:
        'Checkout is unavailable and the billing surfaces say so. Engagements are delivered ' +
        'on whatever arrangement the firm has outside the platform.',
      severity: 'visible',
    },
    {
      key: 'google_sso',
      label: 'Sign in with Google',
      configured:
        set(config.GOOGLE_CLIENT_ID) && set(config.GOOGLE_CLIENT_SECRET) && set(config.GOOGLE_REDIRECT_URI),
      env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
      fallback:
        'GET /auth/providers tells the app not to draw the button, so nobody is offered a ' +
        'sign-in that would fail.',
      severity: 'visible',
    },
  ];
}

/**
 * The ones that are off *and* say nothing about it — the answer to "is anything
 * quietly not happening".
 */
export function silentlyDegraded(config: CapabilityConfig): OptionalCapability[] {
  return optionalCapabilities(config).filter((c) => !c.configured && c.severity === 'silent');
}
