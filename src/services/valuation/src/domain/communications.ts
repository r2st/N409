import type { EmailSpec } from './emailWorkflows.js';

/**
 * Communication templates + auto email/SMS campaigns (409.ai §15.5/§15.6).
 *
 * Pure logic only: {{var}} rendering, override merging for the workflow
 * emails, and the due-window arithmetic for drip campaigns. DB access lives
 * in repos/communications.ts; orchestration in hooks/autoEmails.ts.
 */

export type CommChannel = 'email' | 'sms';

export const AUTO_EMAIL_CONDITIONS = ['always', 'unpaid', 'no_documents', 'waiting_on_client'] as const;
export type AutoEmailCondition = (typeof AUTO_EMAIL_CONDITIONS)[number];

export interface CommunicationTemplateRow {
  id: string;
  key: string;
  channel: CommChannel;
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
  created_at: Date;
  updated_at: Date;
}

export type TemplateVars = Record<string, string | number | null | undefined>;

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

/** The variable set every valuation-scoped template can interpolate. */
export function valuationTemplateVars(v: {
  company_name: string;
  kind: string;
  number?: number | string | null;
}): TemplateVars {
  return {
    company_name: v.company_name,
    kind: v.kind,
    kind_label: v.kind.toUpperCase(),
    valuation_number: v.number ?? '',
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
