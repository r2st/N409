/** API entity types — mirror src/services/valuation domain + route payloads. */

export interface User {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  verified: boolean;
  sso_provider: string | null;
  partner_id: string | null;
  roles: string[];
}

export const VALUATION_KINDS = [
  '409a',
  'fmv',
  '718',
  '820',
  'gifts',
  'qsbs',
  'csop',
  'emi',
  'ifrs2',
  'ppa',
  'goodwill',
  'esop',
  'ip',
] as const;
export type ValuationKind = (typeof VALUATION_KINDS)[number];

export const VALUATION_STATES = [
  'pending',
  'started',
  'onboarding_completed',
  'user_finished',
  'completed',
  'review',
  'reviewed',
  'drafted',
  'draft_accepted',
  'draft_changes',
  'published',
  'timeout',
  'cancelled',
  'ignored',
] as const;
export type ValuationState = (typeof VALUATION_STATES)[number];

export interface Valuation {
  id: string;
  kind: ValuationKind;
  state: ValuationState;
  company_name: string;
  service_name: string | null;
  user_id: string;
  partner_id: string | null;
  source: string | null;
  currency: string | null;
  service_countries: string[] | null;
  waiting_on_client: boolean;
  assigned_reviewer_id: string | null;
  due_date: string | null;
  delivery_days: number | null;
  paid_status: 'unpaid' | 'paid' | 'paid_by_partner';
  qsbs_attestation: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface ValuationEvent {
  id: string;
  valuation_id: string;
  seq: string;
  type: string;
  actor_type: string;
  actor_id: string | null;
  source: string | null;
  payload: Record<string, unknown> | null;
  occurred_at: string;
}

export interface ValuationList {
  valuations: Valuation[];
  page: number;
  per_page: number;
  total: number;
}

export interface AuthProviders {
  password: boolean;
  google: boolean;
}
