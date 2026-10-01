import type { ValuationState } from './valuation.js';

/**
 * Auto email workflows + notification rules (M4, P1 #21 / P2 #27).
 *
 * Declarative map from a state transition to who gets told what. Pure —
 * rendering takes a snapshot of the valuation, the hook layer resolves
 * recipients to actual users and writes outbox rows / notifications in the
 * same transaction as the state change.
 */

export type Recipient = 'owner' | 'reviewer';

/**
 * The frozen event-type taxonomy for notification preferences (P2 #11).
 * Every RULES entry's templateKey / notify type MUST be one of these — the
 * preference matrix keys on them. Transactional account emails (password
 * reset, invitations) are intentionally NOT here: they always deliver.
 */
export const NOTIFICATION_EVENT_TYPES = [
  'valuation_started',
  'review_needed',
  'draft_ready',
  'changes_requested',
  'valuation_completed',
  'valuation_cancelled',
  /**
   * Marketing consent (migration 0118). Not a workflow transition — no rule in
   * this module ever emits it — but it belongs in this taxonomy because it is
   * the same sparse default-on matrix and the same settings screen, and a
   * client should find "stop sending me renewal offers" beside the rest of
   * their notification switches rather than somewhere else.
   *
   * Only `promotional = true` auto-email campaigns consult it; every
   * transactional send ignores it, which is the point. See
   * `domain/communications.isSuppressed`.
   */
  'marketing',
  /**
   * A message on the engagement thread (`hooks/commentNotifications.ts`). Like
   * `marketing` it is not a transition, so no rule in this module emits it —
   * but it is a thing a reader can reasonably want fewer of, and the switch has
   * to exist somewhere the client already looks.
   */
  'comment_posted',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export interface ValuationSnapshot {
  id: string;
  kind: string;
  company_name: string;
  user_id: string;
  assigned_reviewer_id: string | null;
  /** Present on full rows — enables white-label email overrides (improvement 8). */
  partner_id?: string | null;
  /**
   * Also present on full rows, and every `onStateChanged` caller passes one.
   *
   * Declared rather than left to arrive unannounced through `ValuationRow`'s
   * index signature: `valuationTemplateVars` reads all three, so until they
   * were named here a template using `{{due_date}}` worked only by accident of
   * what the callers happened to hand over, and would have started rendering
   * blank the day one of them narrowed its argument.
   */
  number?: string | number | null;
  due_date?: Date | string | null;
  state?: string | null;
}

export interface EmailSpec {
  recipient: Recipient;
  templateKey: string;
  subject: string;
  body: string;
}

export interface NotificationSpec {
  recipient: Recipient;
  type: string;
  title: string;
  body: string;
}

interface TransitionRule {
  email?: Array<{
    recipient: Recipient;
    templateKey: string;
    subject: (v: ValuationSnapshot) => string;
    body: (v: ValuationSnapshot) => string;
  }>;
  notify?: Array<{
    recipient: Recipient;
    type: string;
    title: (v: ValuationSnapshot) => string;
    body: (v: ValuationSnapshot) => string;
  }>;
}

const label = (v: ValuationSnapshot) => `${v.kind.toUpperCase()} valuation for ${v.company_name}`;

/** Rules keyed by the state being ENTERED. */
const RULES: Partial<Record<ValuationState, TransitionRule>> = {
  started: {
    email: [
      {
        recipient: 'owner',
        templateKey: 'valuation_started',
        subject: (v) => `We've started your ${label(v)}`,
        body: (v) =>
          `Work on your ${label(v)} has begun. We'll let you know as soon as anything needs your input.`,
      },
    ],
  },
  review: {
    email: [
      {
        recipient: 'reviewer',
        templateKey: 'review_needed',
        subject: (v) => `Review needed: ${label(v)}`,
        body: (v) => `The ${label(v)} is ready for review. Please pick it up in the dashboard.`,
      },
    ],
    notify: [
      {
        recipient: 'reviewer',
        type: 'review_needed',
        title: () => 'Review needed',
        body: (v) => `${label(v)} is waiting on your review.`,
      },
    ],
  },
  drafted: {
    email: [
      {
        recipient: 'owner',
        templateKey: 'draft_ready',
        subject: (v) => `Your draft ${label(v)} is ready`,
        body: (v) =>
          `A draft of your ${label(v)} is ready for your review. Sign in to accept it or request changes.`,
      },
    ],
    notify: [
      {
        recipient: 'owner',
        type: 'draft_ready',
        title: () => 'Draft ready',
        body: (v) => `A draft of your ${label(v)} is ready for review.`,
      },
    ],
  },
  draft_changes: {
    notify: [
      {
        recipient: 'reviewer',
        type: 'changes_requested',
        title: () => 'Changes requested',
        body: (v) => `The client requested changes on the ${label(v)}.`,
      },
    ],
  },
  published: {
    email: [
      {
        recipient: 'owner',
        templateKey: 'valuation_completed',
        subject: (v) => `Your ${label(v)} is complete`,
        body: (v) =>
          `Your ${label(v)} has been finalized and published. The report is available in your dashboard.`,
      },
    ],
    notify: [
      {
        recipient: 'owner',
        type: 'valuation_completed',
        title: () => 'Valuation complete',
        body: (v) => `Your ${label(v)} has been published.`,
      },
    ],
  },
  cancelled: {
    email: [
      {
        recipient: 'owner',
        templateKey: 'valuation_cancelled',
        subject: (v) => `Your ${label(v)} was cancelled`,
        body: (v) => `Your ${label(v)} has been cancelled. Reply to this email if that's unexpected.`,
      },
    ],
  },
};

export function emailsForTransition(v: ValuationSnapshot, to: ValuationState): EmailSpec[] {
  return (RULES[to]?.email ?? []).map((r) => ({
    recipient: r.recipient,
    templateKey: r.templateKey,
    subject: r.subject(v),
    body: r.body(v),
  }));
}

// ── White-label overrides (improvement 8) ─────────────────────────────────────

/** The workflow emails a partner may re-template (RULES entries with email). */
export const PARTNER_EMAIL_TEMPLATE_KEYS = [
  'valuation_started',
  'review_needed',
  'draft_ready',
  'valuation_completed',
  'valuation_cancelled',
] as const;

export type PartnerEmailTemplates = Partial<
  Record<(typeof PARTNER_EMAIL_TEMPLATE_KEYS)[number], { subject: string; body: string }>
>;

/**
 * What a partner's own template may interpolate.
 *
 * The three named ones are required, so a caller cannot forget the names the
 * partner editor advertises. The index signature is the rest of the catalog:
 * the send path assembles every scope it can answer for the *platform*
 * template a line earlier and then rebuilt a three-key subset for the
 * partner's, so a white-label template writing `{{kind_label}}` — the phrasing
 * every seeded template uses — or `{{recipient_name}}` reached the partner's
 * own client as literal braces. The mirror of the `{{partner_name}}` gap
 * recorded above, in the other direction.
 *
 * A `type` rather than an `interface`, for the reason `ReportTemplateVars`
 * carries: only an object type alias gets TypeScript's implicit index
 * signature, and without one a `{{placeholder}}` lookup cannot read this shape
 * without being laundered through `as unknown as`.
 */
export type EmailTemplateVars = {
  company_name: string;
  kind: string;
  partner_name: string;
} & Record<string, string | number | null | undefined>;

/**
 * {{placeholder}} substitution; unknown placeholders survive verbatim.
 *
 * `Object.hasOwn` rather than a plain lookup — see `renderTemplate` in
 * `domain/communications.ts`, which carries this function and this note. `\w+`
 * matches the names on `Object.prototype`, so `{{constructor}}` in a partner
 * email template rendered as `function Object() { [native code] }`.
 */
export function renderEmailTemplate(text: string, vars: EmailTemplateVars): string {
  const lookup: Readonly<Record<string, unknown>> = vars;
  return text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => {
    if (!Object.hasOwn(vars, key)) return m;
    const v = lookup[key];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * Applies a partner's template overrides to the default workflow emails.
 * Untemplated keys keep the platform default; subject and body are only
 * replaced together, from the same override.
 */
export function applyPartnerEmailTemplates(
  specs: EmailSpec[],
  templates: PartnerEmailTemplates,
  vars: EmailTemplateVars,
): EmailSpec[] {
  return specs.map((spec) => {
    const override = templates[spec.templateKey as (typeof PARTNER_EMAIL_TEMPLATE_KEYS)[number]];
    if (!override?.subject || !override.body) return spec;
    return {
      ...spec,
      subject: renderEmailTemplate(override.subject, vars),
      body: renderEmailTemplate(override.body, vars),
    };
  });
}

export function notificationsForTransition(v: ValuationSnapshot, to: ValuationState): NotificationSpec[] {
  return (RULES[to]?.notify ?? []).map((r) => ({
    recipient: r.recipient,
    type: r.type,
    title: r.title(v),
    body: r.body(v),
  }));
}

/**
 * Which channels each event type can actually reach a reader on.
 *
 * The preference matrix is a grid of two checkboxes per event type, and four
 * of them controlled nothing. `valuation_started` and `valuation_cancelled`
 * have an email rule and no notify rule, so their in-app switch was inert;
 * `changes_requested` has a notify rule and no email rule, so its email switch
 * was; `marketing` is an email-only campaign gate and offered an in-app switch
 * too, under a row the settings screen labelled with the raw key `marketing`
 * because `EVENT_LABELS` had never been extended for it.
 *
 * A switch that controls nothing is worse than a missing one. A client who
 * wants to hear about a cancellation in the app and not by mail could set
 * exactly that and be told nothing at all, and nothing anywhere would report
 * the setting had no effect — the dispatch path reads `channelsFor` for a
 * channel that is never consulted, so the preference is honoured perfectly and
 * is still a lie.
 *
 * Derived from `RULES` rather than written out, so a rule that gains or loses
 * a channel cannot leave this behind. The two entries that are not transitions
 * are declared: `marketing` is consulted by the drip scan
 * (`domain/communications.isSuppressed`, email only) and `comment_posted` by
 * `hooks/commentNotifications.ts` (in-app only). The census in
 * `test/unit/emailWorkflows.test.ts` runs both directions over this — no event
 * type may advertise a channel nothing produces, and none may produce on a
 * channel it does not advertise.
 */
export interface EventChannels {
  in_app: boolean;
  email: boolean;
}

const NON_TRANSITION_CHANNELS: Partial<Record<NotificationEventType, EventChannels>> = {
  marketing: { in_app: false, email: true },
  comment_posted: { in_app: true, email: false },
};

export const NOTIFICATION_EVENT_CHANNELS: Readonly<Record<NotificationEventType, EventChannels>> = (() => {
  const out = Object.fromEntries(
    NOTIFICATION_EVENT_TYPES.map((t) => [
      t,
      { ...(NON_TRANSITION_CHANNELS[t] ?? { in_app: false, email: false }) },
    ]),
  ) as Record<NotificationEventType, EventChannels>;
  for (const rule of Object.values(RULES)) {
    for (const e of rule?.email ?? []) {
      const entry = out[e.templateKey as NotificationEventType];
      if (entry) entry.email = true;
    }
    for (const n of rule?.notify ?? []) {
      const entry = out[n.type as NotificationEventType];
      if (entry) entry.in_app = true;
    }
  }
  return out;
})();

// ── Transactional templates (P0 #3 password reset, feature #9 invitations) ───
// Account emails, not workflow emails — rendered directly by the auth/admin
// routes and always delivered regardless of notification settings.

export interface TransactionalEmail {
  templateKey: string;
  subject: string;
  body: string;
}

export function passwordResetEmail(link: string): TransactionalEmail {
  return {
    templateKey: 'password_reset',
    subject: 'Reset your DoAide 409A password',
    body:
      `We received a request to reset the password for your DoAide 409A account.\n\n` +
      `Use this link within the next hour to choose a new password:\n\n${link}\n\n` +
      `If you didn't request this, you can safely ignore this email — your password is unchanged.`,
  };
}

export function emailVerificationEmail(link: string): TransactionalEmail {
  return {
    templateKey: 'email_verification',
    subject: 'Verify your DoAide 409A email address',
    body:
      `Welcome to DoAide 409A. Please confirm this is your email address so we can secure your account.\n\n` +
      `Use this link within the next 24 hours to verify:\n\n${link}\n\n` +
      `If you didn't create a DoAide 409A account, you can safely ignore this email.`,
  };
}

export function invitationEmail(link: string, invitedByEmail: string): TransactionalEmail {
  return {
    templateKey: 'user_invite',
    subject: "You've been invited to DoAide 409A",
    body:
      `${invitedByEmail} invited you to the DoAide 409A valuations workspace.\n\n` +
      `Use this link within the next 7 days to set your password and sign in:\n\n${link}\n\n` +
      `If you weren't expecting this invitation, you can ignore this email.`,
  };
}
