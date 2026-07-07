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
  number?: string | number;
  workflow_id?: string | null;
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

// ── M3 — Operations ──────────────────────────────────────────────────────────

export const STATE_GROUPS = ['open', 'in_review', 'drafted', 'published', 'closed'] as const;
export type StateGroupKey = (typeof STATE_GROUPS)[number];

export type ValuationCounts = Record<StateGroupKey | 'all', number>;

export const COMMENT_KINDS = ['chat', 'note', 'email'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export interface Comment {
  id: string;
  valuation_id: string;
  kind: CommentKind;
  author_id: string | null;
  author_name: string | null;
  author_email: string | null;
  body: string;
  email_meta: { from?: string; subject?: string; message_id?: string } | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiToken {
  id: string;
  partner_id: string;
  created_by: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  verified: boolean;
  sso_provider: string | null;
  partner_id: string | null;
  partner_name: string | null;
  roles: string[];
  created_at: string;
  deleted_at: string | null;
}

export interface Partner {
  id: string;
  name: string;
  key: string;
  created_at: string;
}

export interface UserOption {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

export interface KindPivotRow {
  kind: ValuationKind;
  open: number;
  in_review: number;
  drafted: number;
  published: number;
  closed: number;
  total: number;
}

export interface DashboardAnalytics {
  total: number;
  by_kind: KindPivotRow[];
  by_state: Record<string, number>;
  by_source: Record<string, number>;
}
