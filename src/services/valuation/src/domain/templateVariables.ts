/**
 * The declared variable set an email/SMS template may interpolate.
 *
 * `renderTemplate` (domain/communications.ts) leaves an unknown `{{placeholder}}`
 * verbatim, which is the right runtime behaviour — a client reading
 * "{{company_nmae}}" in an email is bad, and a client reading an email with a
 * silently empty sentence is worse, because nobody finds out. What that
 * behaviour cannot do is tell the operator, at the moment they typed it, that
 * they misspelled it. Nothing did: the first report of a broken template was
 * the client who received it.
 *
 * So the catalog is a declaration, checked at save time and offered to the
 * editor as a palette. It is deliberately not derived from the rendering call
 * sites — a variable is in this list because we promise to supply it, and a
 * variable disappearing from a call site should break the build here rather
 * than quietly start rendering literally.
 */

import { renderTemplate, type TemplateVars } from './communications.js';

export type TemplateVarScope =
  /** Always available, on every template, whatever sends it. */
  | 'always'
  /** Available on anything a valuation sends. Absent on account emails. */
  | 'valuation'
  /** Available only where a link is generated — reset, invite, payment. */
  | 'link'
  /**
   * Available only on a settlement confirmation — the receipt for an
   * engagement payment, the notice that a subscription invoice was paid.
   * Its own scope rather than `valuation` because half of it is not about an
   * engagement at all (a subscription invoice has no valuation), and because
   * the `valuation` scope is pinned by a census against what
   * `valuationTemplateVars` supplies.
   */
  | 'payment';

export interface TemplateVariable {
  name: string;
  scope: TemplateVarScope;
  description: string;
  /** What the preview renders when there is no real row to read. */
  sample: string;
}

export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  {
    name: 'recipient_name',
    scope: 'always',
    description: "The recipient's first name, or their email when we have no name.",
    sample: 'Dana',
  },
  {
    name: 'platform_name',
    scope: 'always',
    description: 'The sending brand — the platform, or the partner firm on a white-labelled send.',
    sample: 'N409',
  },
  {
    name: 'support_email',
    scope: 'always',
    description: 'The reply-to address a client should raise a question at.',
    sample: 'support@n409.local',
  },
  {
    name: 'company_name',
    scope: 'valuation',
    description: 'The subject company of the engagement.',
    sample: 'Acme Corp',
  },
  {
    name: 'kind',
    scope: 'valuation',
    description: 'Engagement kind as stored — 409a, asc718, asc820, fmv, gift, ifrs2, ip, nav.',
    sample: '409a',
  },
  {
    name: 'kind_label',
    scope: 'valuation',
    description: 'The same kind upper-cased for prose — "409A".',
    sample: '409A',
  },
  {
    name: 'valuation_number',
    scope: 'valuation',
    description: 'The engagement number a client quotes when they write in.',
    sample: '1766',
  },
  {
    name: 'valuation_date',
    scope: 'valuation',
    description: 'The measurement date the opinion is as of (YYYY-MM-DD), blank until it is set.',
    sample: '2026-08-07',
  },
  {
    name: 'due_date',
    scope: 'valuation',
    description: 'The delivery date promised for this engagement, blank when none is set.',
    sample: '2026-08-21',
  },
  {
    name: 'state_label',
    scope: 'valuation',
    description: 'Where the engagement currently stands, in the words the client-facing UI uses.',
    sample: 'In progress',
  },
  {
    name: 'partner_name',
    scope: 'valuation',
    description: 'The partner firm the engagement belongs to, blank on a direct client.',
    sample: 'Fidelity',
  },
  {
    name: 'valuation_link',
    scope: 'link',
    description: "A signed-in link to the engagement's own page.",
    sample: 'https://app.n409.local/valuations/01JQ…',
  },
  {
    name: 'payment_link',
    scope: 'link',
    description: 'The checkout link for an unpaid engagement.',
    sample: 'https://app.n409.local/valuations/01JQ…/pay',
  },
  {
    name: 'invitation_link',
    scope: 'link',
    description: 'A single-use link that accepts a seat invitation.',
    sample: 'https://app.n409.local/accept-invite#token=…',
  },
  {
    name: 'link',
    scope: 'link',
    description: 'The one action link a transactional email is about — reset, verify, or sign.',
    sample: 'https://app.n409.local/reset-password#token=…',
  },
  {
    name: 'receipt_link',
    scope: 'link',
    description: "A signed-in link to the itemised receipt for an engagement's payment.",
    sample: 'https://app.n409.local/valuations/01JQ…/payments',
  },
  {
    name: 'invoice_link',
    scope: 'link',
    description: 'A signed-in link to the billing page an invoice can be downloaded from.',
    sample: 'https://app.n409.local/billing',
  },
  {
    name: 'amount_paid',
    scope: 'payment',
    description: 'What was actually charged, formatted in the currency it was charged in.',
    sample: '$1,190.00',
  },
  {
    name: 'invoice_number',
    scope: 'payment',
    description: 'The sequenced invoice number a subscription payment was billed under.',
    sample: 'INV-202608-0007',
  },
  {
    name: 'invoice_period',
    scope: 'payment',
    description: 'The service period an invoice covers, blank unless both ends of it are known.',
    sample: '2026-08-01 to 2026-09-01',
  },
];

export const TEMPLATE_VARIABLE_NAMES: ReadonlySet<string> = new Set(TEMPLATE_VARIABLES.map((v) => v.name));

/** Every `{{name}}` a template body/subject actually uses, in first-seen order. */
export function collectPlaceholders(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const [, name] of text.matchAll(/\{\{(\w+)\}\}/g)) seen.add(name!);
  }
  return [...seen];
}

/**
 * Placeholders the template uses that nothing will ever supply.
 *
 * A warning and not an error, at every call site: templates are edited by
 * operators against a catalog that grows, and refusing to save a template that
 * names a variable we have not built yet would make the catalog's growth a
 * deployment ordering problem. The editor shows these; the save goes through.
 */
export function unknownPlaceholders(...texts: string[]): string[] {
  return collectPlaceholders(...texts).filter((name) => !TEMPLATE_VARIABLE_NAMES.has(name));
}

/** The catalog's sample values — what a preview renders with no row to read. */
export function sampleTemplateVars(): TemplateVars {
  return Object.fromEntries(TEMPLATE_VARIABLES.map((v) => [v.name, v.sample]));
}

/**
 * Preview a template. Caller-supplied vars win over the samples, so a preview
 * against a real engagement shows that engagement's figures and still fills the
 * variables it has no answer for rather than leaving `{{payment_link}}` in the
 * middle of a sentence.
 */
export function previewTemplate(
  template: { subject: string; body: string },
  vars: TemplateVars = {},
): { subject: string; body: string; unknown_variables: string[] } {
  const merged = { ...sampleTemplateVars(), ...vars };
  return {
    subject: renderTemplate(template.subject, merged),
    body: renderTemplate(template.body, merged),
    unknown_variables: unknownPlaceholders(template.subject, template.body),
  };
}
