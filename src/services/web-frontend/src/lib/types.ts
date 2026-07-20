/** API entity types — mirror src/services/valuation domain + route payloads. */

export interface User {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  job_title: string | null;
  company_name: string | null;
  timezone: string | null;
  verified: boolean;
  sso_provider: string | null;
  partner_id: string | null;
  roles: string[];
  /** Whether TOTP 2FA is enabled (feature: MFA). Absent on older payloads. */
  totp_enabled?: boolean;
}

/** A personal API token. The secret is returned only once, at creation. */
export interface ApiToken {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface SystemSettings {
  registration_enabled: boolean;
  maintenance_mode: boolean;
  password_min_length: number;
  support_email: string;
  default_delivery_days: number;
  require_mfa: boolean;
}

export type SystemSettingKey = keyof SystemSettings;

/** Public subset served to signed-out visitors. */
export type PublicSystemSettings = Pick<
  SystemSettings,
  'registration_enabled' | 'maintenance_mode' | 'support_email'
>;

export interface SystemSettingsResponse {
  settings: SystemSettings;
  defaults: SystemSettings;
  /** Only carries keys an admin has actually written. */
  updated: Partial<Record<SystemSettingKey, { updated_at: string; updated_by: string | null }>>;
  editable: boolean;
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
  /** Computed per-viewer on the list (gap 4): conversation moved since last opened. */
  unread?: boolean;
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
  /** Enterprise SAML SSO configured + enabled (feature 9). */
  saml?: boolean;
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
  job_title: string | null;
  company_name: string | null;
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
  archived_at: string | null;
  brand_color: string | null;
  logo_url: string | null;
  /** White-label workflow email overrides (improvement 8). */
  email_templates?: Record<string, { subject: string; body: string }>;
  user_count: number;
  valuation_count: number;
}

/** Workflow emails a partner may re-template — mirrors the server list. */
export const PARTNER_EMAIL_TEMPLATE_KEYS = [
  'valuation_started',
  'review_needed',
  'draft_ready',
  'valuation_completed',
  'valuation_cancelled',
] as const;

// ── P1 #7 — Partner management ───────────────────────────────────────────────

export interface PartnerDetail extends Partner {
  valuations_by_group: Record<string, number>;
  last_activity_at: string | null;
  users: Array<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    roles: string[];
  }>;
}

/** The slice of their own organisation a partner user can see (branding). */
export interface PartnerBranding {
  id: string;
  name: string;
  key: string;
  brand_color: string | null;
  logo_url: string | null;
}

export interface Invitation {
  id: string;
  email: string;
  roles: string[];
  partner_id: string | null;
  partner_name: string | null;
  invited_by_email: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export type OutboxStatus = 'queued' | 'sent' | 'failed' | 'skipped';
export type CommChannel = 'email' | 'sms';

export interface OutboxEmail {
  id: string;
  valuation_id: string | null;
  to_user_id: string | null;
  to_email: string;
  channel?: CommChannel;
  template_key: string;
  subject: string;
  body: string;
  status: OutboxStatus;
  error: string | null;
  attempts: number;
  created_at: string;
  sent_at: string | null;
}

// §15.5/§15.6 — communication templates + auto email campaigns

export interface CommunicationTemplate {
  id: string;
  key: string;
  channel: CommChannel;
  description: string;
  subject: string;
  body: string;
  enabled: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export type AutoEmailCondition = 'always' | 'unpaid' | 'no_documents' | 'waiting_on_client';

export interface AutoEmail {
  id: string;
  name: string;
  channel: CommChannel;
  trigger_state: ValuationState;
  condition: AutoEmailCondition;
  delay_hours: number;
  repeat_hours: number | null;
  max_sends: number;
  template_key: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
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

// ── M4 — Polish ───────────────────────────────────────────────────────────────

export interface ReportTemplate {
  id: string;
  name: string;
  version: number;
  label: string;
  kind: ValuationKind;
  status: 'draft' | 'active' | 'archived';
  body: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppNotification {
  id: string;
  valuation_id: string | null;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
}

export interface FundingRound {
  id: string;
  name: string;
  security_type: string | null;
  closed_on: string | null;
  amount_raised_cents: string | null;
  pre_money_cents: string | null;
  post_money_cents: string | null;
  shares_issued: string | null;
  notes: string | null;
}

export const TRANSACTION_KINDS = [
  'issuance',
  'secondary_sale',
  'repurchase',
  'conversion',
  'transfer',
  'other',
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export interface ValuationTransaction {
  id: string;
  kind: TransactionKind;
  occurred_on: string;
  shares: string | null;
  price_per_share_cents: string | null;
  counterparty: string | null;
  notes: string | null;
}

export interface SearchResults {
  valuations: Array<{
    id: string;
    number: string;
    kind: ValuationKind;
    state: ValuationState;
    company_name: string;
    service_name: string | null;
    created_at: string;
  }>;
  users: Array<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    partner_id: string | null;
  }>;
}

export interface SensitivityCell {
  volatility: number;
  termYears: number;
  fmvPerShareCents: number;
  deltaFromBase: number;
}

export type SensitivityAxis = 'volatility' | 'termYears' | 'riskFreeRate';

export interface AxisCell {
  fmvPerShareCents: number;
  deltaFromBase: number;
}

export interface AxisTable {
  rowAxis: SensitivityAxis;
  colAxis: SensitivityAxis;
  rowValues: number[];
  colValues: number[];
  rows: AxisCell[][];
}

export interface SensitivityResult {
  base: { volatility: number; termYears: number; riskFreeRate?: number; fmvPerShareCents: number };
  volatilities: number[];
  terms: number[];
  rows: SensitivityCell[][];
  /** Three-table dashboard: Term×Vol, RFR×Vol, RFR×Term. */
  tables?: { term_vol: AxisTable; rfr_vol: AxisTable; rfr_term: AxisTable };
  dlom: number;
  currency: string | null;
}

// ── P0 #2 — Payments ─────────────────────────────────────────────────────────

export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'expired'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface Payment {
  id: string;
  valuation_id: string;
  provider: string;
  session_id: string;
  payment_intent_id: string | null;
  amount_cents: string | number;
  currency: string;
  status: PaymentStatus;
  checkout_url: string | null;
  charge_id: string | null;
  receipt_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentQuote {
  amount_cents: number;
  currency: string;
  kind: ValuationKind;
  configured: boolean;
}

// ── P1 #6 — Review workflow ──────────────────────────────────────────────────

/** A valuation awaiting review, with signature rollups for publish gating. */
export interface ReviewQueueItem extends Valuation {
  signed_main: boolean;
  signed_second: boolean;
}

export interface BulkResult {
  results: Array<{ id: string; ok: boolean; error?: string; state?: ValuationState }>;
  succeeded: number;
  failed: number;
}
