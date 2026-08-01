/**
 * Client intake questionnaire (feature 7). A guided, sectioned data-collection
 * form the client fills in during onboarding. The schema lives here (pure) so
 * both the completion calculation and the frontend wizard render from one
 * source of truth.
 */

export const INTAKE_EVENT_TYPES = {
  saved: 'intake_saved',
  submitted: 'intake_submitted',
  reminderSent: 'document_reminder_sent',
} as const;

export type IntakeFieldType = 'text' | 'textarea' | 'number' | 'date' | 'boolean' | 'select';

export interface IntakeField {
  key: string;
  label: string;
  type: IntakeFieldType;
  required: boolean;
  options?: string[];
  hint?: string;
}

export interface IntakeSection {
  key: string;
  title: string;
  description: string;
  fields: IntakeField[];
}

export const INTAKE_SECTIONS: readonly IntakeSection[] = [
  {
    key: 'company',
    title: 'Company information',
    description: 'Tell us about the company being valued.',
    fields: [
      { key: 'legal_name', label: 'Legal company name', type: 'text', required: true },
      {
        key: 'state_of_incorporation',
        label: 'State / country of incorporation',
        type: 'text',
        required: true,
      },
      { key: 'incorporation_date', label: 'Date of incorporation', type: 'date', required: true },
      { key: 'industry', label: 'Industry / sector', type: 'text', required: true },
      { key: 'employee_count', label: 'Number of employees', type: 'number', required: false },
      {
        key: 'business_description',
        label: 'Business description',
        type: 'textarea',
        required: true,
        hint: 'A few sentences on what the company does.',
      },
    ],
  },
  {
    key: 'financials',
    title: 'Financials',
    description: 'High-level financial position. Detailed statements are uploaded as documents.',
    fields: [
      {
        key: 'revenue_status',
        label: 'Revenue stage',
        type: 'select',
        required: true,
        options: ['pre_revenue', 'post_revenue'],
      },
      { key: 'last_fy_revenue', label: 'Last fiscal-year revenue', type: 'number', required: false },
      { key: 'ytd_revenue', label: 'Year-to-date revenue', type: 'number', required: false },
      { key: 'cash_on_hand', label: 'Cash on hand', type: 'number', required: false },
      { key: 'monthly_burn', label: 'Monthly net burn', type: 'number', required: false },
    ],
  },
  {
    key: 'cap_table',
    title: 'Capitalization',
    description: 'Summary cap-table figures. Upload the full cap table as a document.',
    fields: [
      { key: 'total_shares_outstanding', label: 'Total shares outstanding', type: 'number', required: true },
      { key: 'option_pool_size', label: 'Option pool size (shares)', type: 'number', required: false },
      { key: 'last_round_name', label: 'Most recent financing round', type: 'text', required: false },
      { key: 'last_round_price', label: 'Most recent price per share', type: 'number', required: false },
      { key: 'last_round_date', label: 'Most recent round close date', type: 'date', required: false },
    ],
  },
  {
    key: 'legal',
    title: 'Legal & governance',
    description: 'Charter documents and anything affecting value.',
    fields: [
      { key: 'has_articles', label: 'Articles of incorporation available?', type: 'boolean', required: true },
      { key: 'has_charter_amendments', label: 'Any charter amendments?', type: 'boolean', required: false },
      { key: 'pending_litigation', label: 'Any pending litigation?', type: 'boolean', required: false },
      {
        key: 'anticipated_liquidity',
        label: 'Anticipated liquidity event / timeline',
        type: 'text',
        required: false,
      },
    ],
  },
] as const;

/** True when a field's answer counts as provided (0 and false are valid answers). */
export function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

export interface SectionCompletion {
  key: string;
  title: string;
  requiredTotal: number;
  requiredAnswered: number;
  answeredTotal: number;
  fieldTotal: number;
  complete: boolean;
}

export interface IntakeCompletion {
  sections: SectionCompletion[];
  requiredTotal: number;
  requiredAnswered: number;
  percentComplete: number;
  /** True when every required field across every section is answered. */
  ready: boolean;
}

/** Compute per-section and overall completion of the questionnaire. */
export function computeCompletion(answers: Record<string, unknown>): IntakeCompletion {
  const sections: SectionCompletion[] = INTAKE_SECTIONS.map((section) => {
    const required = section.fields.filter((f) => f.required);
    const requiredAnswered = required.filter((f) => isAnswered(answers[f.key])).length;
    const answeredTotal = section.fields.filter((f) => isAnswered(answers[f.key])).length;
    return {
      key: section.key,
      title: section.title,
      requiredTotal: required.length,
      requiredAnswered,
      answeredTotal,
      fieldTotal: section.fields.length,
      complete: requiredAnswered === required.length,
    };
  });
  const requiredTotal = sections.reduce((n, s) => n + s.requiredTotal, 0);
  const requiredAnswered = sections.reduce((n, s) => n + s.requiredAnswered, 0);
  return {
    sections,
    requiredTotal,
    requiredAnswered,
    percentComplete: requiredTotal > 0 ? Math.round((requiredAnswered / requiredTotal) * 100) : 100,
    ready: requiredAnswered === requiredTotal,
  };
}

/** Set of field keys the questionnaire recognises — answers are filtered to these. */
export const INTAKE_FIELD_KEYS: ReadonlySet<string> = new Set(
  INTAKE_SECTIONS.flatMap((s) => s.fields.map((f) => f.key)),
);
