import type { EmailSpec } from './emailWorkflows.js';
import { calendarDateOrNull } from './calendarDate.js';

/**
 * Communication templates + auto email/SMS campaigns (409.ai §15.5/§15.6).
 *
 * Pure logic only: {{var}} rendering, override merging for the workflow
 * emails, and the due-window arithmetic for drip campaigns. DB access lives
 * in repos/communications.ts; orchestration in hooks/autoEmails.ts.
 */

export type CommChannel = 'email' | 'sms';

/**
 * What a campaign is allowed to gate on. Each names something we are actually
 * blocked on and can see in the schema; the SQL for each is in
 * `repos/communications.ts` and the DB constraint is migration 0104.
 *
 * `no_documents` is kept but is the coarsest of them: a client who uploaded a
 * pitch deck and nothing else stops matching it while still being someone to
 * chase, which is why `no_captable` and `no_financials` exist alongside it.
 */
export const AUTO_EMAIL_CONDITIONS = [
  'always',
  'unpaid',
  'no_documents',
  'waiting_on_client',
  'paid',
  'intake_incomplete',
  'no_captable',
  'no_financials',
  'unassigned_reviewer',
  'unsigned',
] as const;
export type AutoEmailCondition = (typeof AUTO_EMAIL_CONDITIONS)[number];

/**
 * How the template list is grouped (migration 0113). Five of the six are the
 * lifecycle groups from `domain/operations.ts` — a template is filed under the
 * stage of the engagement that sends it. `account` is for the templates that
 * are not about an engagement at all: password reset, email verification, the
 * seat invitation. Those three deliver unconditionally, so filing one under a
 * lifecycle state would imply a gate that is not there.
 */
export const TEMPLATE_CATEGORIES = [
  'account',
  'open',
  'in_review',
  'drafted',
  'published',
  'closed',
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_CATEGORY_LABELS: Record<TemplateCategory, string> = {
  account: 'Account',
  open: 'Open',
  in_review: 'In review',
  drafted: 'Drafted',
  published: 'Published',
  closed: 'Closed',
};

export interface CommunicationTemplateRow {
  id: string;
  key: string;
  channel: CommChannel;
  category: TemplateCategory;
  description: string;
  subject: string;
  body: string;
  enabled: boolean;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AutoEmailRow {
  id: string;
  name: string;
  channel: CommChannel;
  trigger_state: string;
  condition: AutoEmailCondition;
  delay_hours: number;
  repeat_hours: number | null;
  max_sends: number;
  template_key: string;
  enabled: boolean;
  /** Marketing rather than transactional (migration 0118). See `isSuppressed`. */
  promotional: boolean;
  created_at: Date;
  updated_at: Date;
}

// ── Promotional vs transactional (migration 0118) ────────────────────────────

/**
 * The `notification_preferences` key that holds marketing consent.
 *
 * The existing matrix is sparse and default-on — a missing row means both
 * channels are enabled — and marketing rides on the same table rather than a
 * new column so there is one place a client's communication preferences live
 * and one settings screen that edits them. Default-on matches how these
 * campaigns have been sending since 0104; the opt-out is what was missing, not
 * the consent.
 */
export const MARKETING_PREFERENCE_KEY = 'marketing';

/**
 * Whether a campaign must not send to this recipient.
 *
 * Asymmetric on purpose, and this asymmetry is the whole control:
 *
 *   * A marketing opt-out suppresses `promotional = true` campaigns only.
 *   * A transactional campaign ignores marketing consent entirely — a client
 *     who unsubscribed from renewal offers still has to be told their draft is
 *     ready, and suppressing that is a service failure, not compliance.
 *
 * One predicate, both directions, so neither branch can be got right in one
 * call site and wrong in another.
 */
export function isSuppressed(
  campaign: Pick<AutoEmailRow, 'promotional'>,
  consent: { marketingEmail: boolean },
): boolean {
  return campaign.promotional && !consent.marketingEmail;
}

/**
 * The unsubscribe footer a promotional message carries, and a transactional
 * one does not.
 *
 * Appended at send time rather than stored in the template: whether a campaign
 * is promotional is a property of the campaign, and a template shared by a
 * transactional and a promotional campaign would otherwise need two copies —
 * which is how one of them ends up without the footer.
 */
export function unsubscribeFooter(settingsUrl: string): string {
  return (
    `\n\n—\nYou are receiving this because you have an account with us. ` +
    `To stop receiving messages like this one, update your preferences at ${settingsUrl}. ` +
    `Notifications about your own valuations are not affected.`
  );
}

/** `body` with the footer, for promotional sends only. */
export function applyPromotionalFooter(
  body: string,
  campaign: Pick<AutoEmailRow, 'promotional'>,
  settingsUrl: string | null,
): string {
  if (!campaign.promotional || !settingsUrl) return body;
  return body + unsubscribeFooter(settingsUrl);
}

export type TemplateVars = Record<string, string | number | null | undefined>;

// ── The scopes a real send has to answer, and the preview already did ────────

/**
 * The platform's own name, and the fallback for `platform_name`.
 *
 * The same string `PLATFORM_BRANDING.name` carries and the built-in
 * transactional copy hard-codes ("Reset your DoAide 409A password"). Duplicated here
 * rather than imported so this module stays free of the branding domain, and
 * pinned by a test against `PLATFORM_BRANDING` so the two cannot drift.
 */
export const PLATFORM_NAME = 'DoAide 409A';

/**
 * The `always` scope of TEMPLATE_VARIABLES — the three names every template may
 * use, whatever sends it.
 *
 * These were declared in the catalog, offered in the editor's palette, and
 * filled in the preview from `sampleTemplateVars()` — and supplied by no send
 * path at all. `renderTemplate` leaves an unknown name verbatim, which is the
 * right treatment of a misspelling and exactly the wrong one here: the name is
 * spelled correctly and nobody was answering it, so a template reading
 * "Hi {{recipient_name}}" previewed as "Hi Dana" and was delivered, to the
 * client, as "Hi {{recipient_name}}".
 *
 * Supplied here rather than at each call site so the three names cannot be
 * answered at one send and left as braces at the next.
 */
export function alwaysTemplateVars(v: {
  /** The recipient's given name, when we hold one. */
  recipient_name?: string | null;
  /** Fallen back to when we do not — the catalog promises the address, not a gap. */
  recipient_email: string;
  /** The partner firm on a white-labelled send; the platform otherwise. */
  platform_name?: string | null;
  /** From system settings; only ever blank if that read failed. */
  support_email?: string | null;
}): TemplateVars {
  const name = v.recipient_name?.trim();
  return {
    recipient_name: name && name.length > 0 ? name : v.recipient_email,
    platform_name: v.platform_name?.trim() || PLATFORM_NAME,
    support_email: v.support_email ?? '',
  };
}

/**
 * The `link` scope an engagement-scoped send can answer from the id alone.
 *
 * `payment_link` is the engagement's own page and not a `/pay` route, because
 * there is no `/pay` route: checkout is a control on the detail page, which is
 * also where `receipt_link` already points (`routes/payments.ts`). One spelling
 * of "where the client goes to settle this", so the link in a campaign email
 * and the link in a receipt cannot disagree.
 *
 * An absent base URL renders both as empty rather than as braces. Neither is
 * good, and PUBLIC_BASE_URL is required in production precisely so neither
 * happens — but a sentence with a gap in it is recoverable and a client
 * emailing support about "{{payment_link}}" is not.
 */
export function valuationLinkVars(baseUrl: string | null | undefined, valuationId: string): TemplateVars {
  const base = baseUrl ? baseUrl.replace(/\/$/, '') : null;
  const link = base ? `${base}/valuations/${valuationId}` : '';
  return { valuation_link: link, payment_link: link };
}

/**
 * {{placeholder}} substitution; unknown placeholders survive verbatim.
 *
 * `Object.hasOwn` rather than a plain lookup, because `\w+` matches the names
 * on `Object.prototype` and a plain lookup finds them. `{{constructor}}`
 * rendered as `function Object() { [native code] }`, and `{{toString}}`,
 * `{{valueOf}}`, `{{hasOwnProperty}}` and `{{__proto__}}` likewise — none of
 * them ever `undefined` or `null`, so none of them ever survived verbatim.
 *
 * The same function appears in `domain/report.ts` (report templates) and
 * `domain/emailWorkflows.ts` (partner emails), and had the same hole; all
 * three take template text an operator or a user authored.
 */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (!Object.hasOwn(vars, key)) return match;
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * The variable set every valuation-scoped template can interpolate — the
 * `valuation` scope of TEMPLATE_VARIABLES, and the whole of what this layer
 * can answer from a valuation row alone.
 *
 * A field the row has not reached yet renders as the empty string rather than
 * surviving as `{{due_date}}`: an engagement with no promised date is the
 * normal case for most of its life, and a client reading literal braces in the
 * middle of a sentence is worse than reading a sentence with a gap in it. That
 * is the opposite of `renderTemplate`'s treatment of an *unknown* name, and
 * deliberately so — unknown means nobody will ever supply it, which is a
 * mistake worth showing; empty means we do not know it yet.
 */
export function valuationTemplateVars(v: {
  company_name: string;
  kind: string;
  number?: number | string | null;
  valuation_date?: Date | string | null;
  due_date?: Date | string | null;
  state?: string | null;
  partner_name?: string | null;
}): TemplateVars {
  // Two readings for two column types — see domain/calendarDate.ts.
  //
  // `valuation_date` is a `date`, handed back by the driver as midnight *local*,
  // and it is the one that reaches a client: an email saying their 409A is "as
  // of" the day before the one printed on the report is the kind of discrepancy
  // that costs a phone call to explain. `due_date` is a timestamptz — a real
  // instant — and keeps the UTC day every other timestamp here is rendered in,
  // so a deadline does not move with the server's zone.
  const day = (d: Date | string | null | undefined): string => calendarDateOrNull(d) ?? '';
  const instant = (d: Date | string | null | undefined): string =>
    d instanceof Date ? d.toISOString().slice(0, 10) : (d ?? '').toString().slice(0, 10);
  return {
    company_name: v.company_name,
    kind: v.kind,
    kind_label: v.kind.toUpperCase(),
    valuation_number: v.number ?? '',
    valuation_date: day(v.valuation_date),
    due_date: instant(v.due_date),
    state_label: v.state ? v.state.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '',
    partner_name: v.partner_name ?? '',
  };
}

/**
 * Applies DB template overrides to the built-in workflow emails. A matching
 * enabled row replaces subject and body (rendered with vars); a disabled or
 * missing row leaves the code default untouched. Overrides never suppress a
 * send — the notification-preference matrix is the kill switch.
 */
export function applyTemplateOverrides(
  specs: EmailSpec[],
  templates: Map<string, Pick<CommunicationTemplateRow, 'subject' | 'body' | 'enabled'>>,
  vars: TemplateVars,
): EmailSpec[] {
  return specs.map((spec) => {
    const override = templates.get(spec.templateKey);
    if (!override?.enabled || !override.subject || !override.body) return spec;
    return {
      ...spec,
      subject: renderTemplate(override.subject, vars),
      body: renderTemplate(override.body, vars),
    };
  });
}

/**
 * Whether a campaign is due for one valuation, given when the valuation
 * entered the trigger state and the campaign's prior sends (newest first).
 */
export function isCampaignDue(
  campaign: Pick<AutoEmailRow, 'delay_hours' | 'repeat_hours' | 'max_sends'>,
  stateEnteredAt: Date,
  priorSendsAt: Date[],
  now: Date = new Date(),
): boolean {
  const hours = 3_600_000;
  if (now.getTime() - stateEnteredAt.getTime() < campaign.delay_hours * hours) return false;
  if (priorSendsAt.length >= campaign.max_sends) return false;
  if (priorSendsAt.length === 0) return true;
  if (campaign.repeat_hours === null) return false; // one-shot already sent
  const lastSent = Math.max(...priorSendsAt.map((d) => d.getTime()));
  return now.getTime() - lastSent >= campaign.repeat_hours * hours;
}
