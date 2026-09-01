import { toCsv } from '../export/csv.js';
import { ellipsize } from './textSlice.js';

/**
 * Audit-trail enrichment over the raw `valuation_events` spine.
 *
 * The spine stores what happened; this module says what it *means* — a stable
 * catalog mapping every event type to a human label, a category, a severity and
 * a visibility, plus the payload normalisation that turns the several payload
 * shapes we write ({ changes }, { from, to }, { fields }, …) into one flat list
 * of field-level changes. Pure functions only, so the whole audit vocabulary is
 * unit-testable and can be reused by the report, the evidence bundle and the
 * client portal without dragging the database along.
 */

export const EVENT_CATEGORIES = [
  'lifecycle',
  'documents',
  'methodology',
  'data',
  'analysis',
  'review',
  'output',
  'access',
  'integration',
  'other',
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/**
 * How much an event matters when reconstructing why a number moved.
 * `critical` events are the ones an auditor must be able to explain: they
 * change the concluded value, the methodology behind it, or the deliverable.
 */
export const EVENT_SEVERITIES = ['info', 'notice', 'critical'] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

/** `internal` events are analyst tooling — never shown outside ops. */
export type EventVisibility = 'client' | 'internal';

export interface EventDescriptor {
  label: string;
  category: EventCategory;
  severity: EventSeverity;
  visibility: EventVisibility;
}

const D = (
  label: string,
  category: EventCategory,
  severity: EventSeverity,
  visibility: EventVisibility = 'internal',
): EventDescriptor => ({ label, category, severity, visibility });

/**
 * Every event type the platform writes to `valuation_events`, and the only
 * ones `recordEvent` will accept.
 *
 * This used to be a `Record<string, EventDescriptor>` kept in sync by hand,
 * with a unit test asserting the catalog covered every `*_EVENT_TYPES`
 * constant map. That test could only see types declared in one of those maps,
 * and not every writer declares one: `repos/pipelineRuns.ts` picks its type
 * inline —
 *
 *     type: status === 'ready' ? 'auto_pipeline_completed' : 'auto_pipeline_failed'
 *
 * — and `auto_pipeline_completed` was never added to the catalog. Its three
 * siblings were, so nothing looked incomplete; the event that says the
 * automated pipeline *finished* was the one that fell through to
 * `UNKNOWN_EVENT` and printed in the change log as "Event recorded", filed
 * under "other", while "Automated pipeline started" sat above it named.
 *
 * The catalog is now the type. `keyof typeof EVENT_CATALOG` is a literal
 * union because of the `satisfies` below, `recordEvent` takes that union, and
 * an event type with no descriptor is a compile error at the line that writes
 * it rather than a label nobody notices is missing. The census test remains,
 * because the constant maps are still worth checking against the catalog in
 * the other direction — but it is no longer the only thing standing between a
 * new event and "Event recorded".
 */
export const EVENT_CATALOG = {
  // ── Lifecycle ───────────────────────────────────────────────────────────
  valuation_created: D('Valuation created', 'lifecycle', 'notice', 'client'),
  valuation_updated: D('Valuation details updated', 'lifecycle', 'notice', 'client'),
  // Client-visible for the same reason `valuation_created` is: it is the
  // creation event of the new engagement, and a client may clone their own.
  // Marked internal until R128, when pushing the catalog's visibility rule
  // into the events route made a client unable to see the engagement they had
  // just created. The payload names only the source they already own — its id,
  // its number, and how many rows came across.
  valuation_cloned: D('Valuation cloned', 'lifecycle', 'notice', 'client'),
  valuation_completed: D('Valuation completed', 'lifecycle', 'critical', 'client'),
  state_changed: D('Stage changed', 'lifecycle', 'notice', 'client'),
  engagement_started: D('Engagement started', 'lifecycle', 'info', 'client'),
  engagement_stage_advanced: D('Engagement stage advanced', 'lifecycle', 'info', 'client'),
  // 'notice', not 'info': a reopen undoes a delivery everybody downstream has
  // already been told about, and it is the one stage move that is not routine.
  engagement_reopened: D('Engagement reopened', 'lifecycle', 'notice', 'client'),
  engagement_analyst_assigned: D('Analyst assigned', 'lifecycle', 'info'),
  engagement_overdue_reminder: D('Overdue reminder sent', 'lifecycle', 'info'),

  // ── Documents & intake ──────────────────────────────────────────────────
  document_uploaded: D('Document uploaded', 'documents', 'notice', 'client'),
  document_deleted: D('Document deleted', 'documents', 'notice', 'client'),
  /*
   * The third side of a document's life, and the one nothing recorded.
   *
   * Arriving, being re-filed and being removed each wrote a row; the bytes
   * *leaving* did not. These are the client's own source materials — audited
   * financials, board minutes, the signed cap table, whatever an intake asked
   * for — and the one place a copy of them is handed out is
   * `/documents/:documentId/download`, which said nothing about who pulled
   * which file or when.
   *
   * `client` visibility, like its three siblings: it is the client's document,
   * and "who has read what I uploaded" is a question they have as much
   * standing to ask as the firm does. The machine reads in `routes/ai.ts` are
   * deliberately not this event — a pipeline run already records itself, and
   * a row per extraction would bury the deliberate downloads this exists to
   * show.
   */
  document_downloaded: D('Document downloaded', 'documents', 'notice', 'client'),
  // Visible to the client: the bucket a document sits in is what the
  // deliverable's evidence list prints, so a re-filing changes what the
  // engagement says it relied on.
  document_refiled: D('Document re-filed', 'documents', 'notice', 'client'),
  document_reminder_sent: D('Document reminder sent', 'documents', 'info', 'client'),
  intake_saved: D('Intake saved', 'documents', 'info', 'client'),
  intake_submitted: D('Intake submitted', 'documents', 'notice', 'client'),
  company_profile_updated: D('Company profile updated', 'documents', 'notice', 'client'),

  // ── Methodology & assumptions ───────────────────────────────────────────
  params_updated: D('Methodology parameters changed', 'methodology', 'critical'),
  methodology_decision_recorded: D('Methodology decision recorded', 'methodology', 'critical'),
  overwrite_applied: D('Analyst overwrite applied', 'methodology', 'critical'),
  overwrite_reverted: D('Analyst overwrite reverted', 'methodology', 'critical'),
  scenario_saved: D('Scenario saved', 'methodology', 'notice', 'client'),
  scenario_deleted: D('Scenario deleted', 'methodology', 'notice', 'client'),

  // ── Underlying data ─────────────────────────────────────────────────────
  cap_table_imported: D('Cap table imported', 'data', 'critical', 'client'),
  cap_table_change: D('Cap table changed', 'data', 'critical', 'client'),
  transaction_added: D('Transaction added', 'data', 'critical'),
  transaction_updated: D('Transaction updated', 'data', 'critical'),
  transaction_deleted: D('Transaction deleted', 'data', 'critical'),
  funding_round: D('Funding round recorded', 'data', 'critical'),
  funding_round_added: D('Funding round added', 'data', 'critical'),
  funding_round_updated: D('Funding round updated', 'data', 'critical'),
  funding_round_deleted: D('Funding round deleted', 'data', 'critical'),
  grant_issued: D('Option grant issued', 'data', 'notice'),
  grant_updated: D('Option grant updated', 'data', 'notice'),
  grant_cancelled: D('Option grant cancelled', 'data', 'notice'),
  revenue_change: D('Revenue changed materially', 'data', 'critical'),
  workbook_updated: D('Workbook edited', 'data', 'notice'),

  /*
   * The ASC 820 measurement surface (round 279, methodology M3).
   *
   * `fund` and `debt` are two of the fifteen valuation kinds, and their whole
   * working record lived off the spine. A fund portfolio and a debt instrument
   * are addressed by their own ids — 0086/0087 built both as standalone ops
   * tools, 0110 linked them to an engagement afterwards — so neither route file
   * ever wrote a `valuation_events` row, and the engagement panel's activity
   * feed for a fund engagement was empty of everything the analyst had done to
   * it. `domain/navExhibits.ts` renders the NAV schedule by summing the stored
   * marks at render time, so every one of these changes the figure the
   * deliverable prints, with nothing on the trail to say who changed it or when.
   *
   * `critical`, alongside `cap_table_change` and `transaction_updated`, for the
   * reason the severity is defined: these are the events an auditor must be
   * able to explain, because they move the concluded value. `internal` like the
   * rest of the working data — the client is shown the report, not the marks.
   *
   * Written only when the subject is linked to an engagement. An unlinked
   * portfolio is an ops sketch with no engagement to write to, and
   * `valuation_events.valuation_id` is NOT NULL.
   */
  // The portfolio's own fields, which R279 left off the catalog while adding
  // the eleven around it. `currency` is the reason it matters most: every
  // stored mark and every LP-terms figure under this fund is a number in it,
  // and the NAV exhibit prints the fund's — so changing it restates the whole
  // schedule's meaning without touching a single figure.
  fund_updated: D('Fund portfolio updated', 'data', 'critical'),
  fund_position_added: D('Fund holding added', 'data', 'critical'),
  fund_position_updated: D('Fund holding updated', 'data', 'critical'),
  fund_position_removed: D('Fund holding removed', 'data', 'critical'),
  fund_mark_recorded: D('Fund holding marked to fair value', 'data', 'critical'),
  fund_lp_terms_updated: D('LP economic terms updated', 'data', 'critical'),
  debt_instrument_updated: D('Debt instrument terms updated', 'data', 'critical'),
  debt_credit_terms_updated: D('Credit terms updated', 'data', 'critical'),
  debt_valuation_recorded: D('Debt instrument priced', 'data', 'critical'),
  // The link is the sharpest of the set in one direction: detaching removes the
  // whole data source the report renders its schedule from, and it is the step
  // `DELETE /funds/:id` tells a caller to take before discarding the marks.
  measurement_subject_linked: D('Measurement subject linked', 'data', 'critical'),
  measurement_subject_unlinked: D('Measurement subject detached', 'data', 'critical'),

  // ── Analysis & automation ───────────────────────────────────────────────
  calculation_completed: D('Calculation completed', 'analysis', 'critical', 'client'),
  ai_job_completed: D('AI job completed', 'analysis', 'info'),
  auto_pipeline_started: D('Automated pipeline started', 'analysis', 'info'),
  // The one the catalog was missing. `info` like its `started` sibling rather
  // than `notice` like `failed`: a run that finishes is the expected outcome,
  // and what it produced is recorded separately as `calculation_completed`.
  auto_pipeline_completed: D('Automated pipeline completed', 'analysis', 'info'),
  auto_pipeline_failed: D('Automated pipeline failed', 'analysis', 'notice'),
  // The retry that was promised and will not happen (round 272, methodology
  // M3). `auto_pipeline_failed` carries `retry_scheduled`, so a reaped run says
  // on the spine that something is coming back for it; when the retry sweep
  // then stands the run down — a newer run supersedes it — that promise is
  // withdrawn, and until R272 the withdrawal appeared nowhere but as a suffix
  // on the `error` column. `notice` like `failed`, because it is the sentence
  // that finishes it.
  auto_pipeline_retry_abandoned: D('Automated pipeline retry abandoned', 'analysis', 'notice'),
  auto_pipeline_toggled: D('Automated pipeline toggled', 'analysis', 'info'),
  health_checks_run: D('Health checks run', 'analysis', 'info'),

  // ── Review & approval ───────────────────────────────────────────────────
  review_task_created: D('Review task created', 'review', 'info'),
  review_task_updated: D('Review task updated', 'review', 'info'),
  review_needed: D('Review requested', 'review', 'notice'),
  review_decision: D('Review decision recorded', 'review', 'critical'),
  qa_review_completed: D('QA review completed', 'review', 'critical'),
  changes_requested: D('Changes requested', 'review', 'notice', 'client'),
  comment_added: D('Comment added', 'review', 'info'),
  board_member_added: D('Board member added', 'review', 'notice'),
  board_member_removed: D('Board member removed', 'review', 'notice'),
  board_resolution_generated: D('Board resolution generated', 'review', 'notice', 'client'),
  board_resolution_sent: D('Board resolution sent', 'review', 'notice', 'client'),
  board_resolution_approved: D('Board resolution approved', 'review', 'critical', 'client'),
  board_resolution_rejected: D('Board resolution rejected', 'review', 'critical', 'client'),
  /**
   * The aggregate going back to 'pending' from a decided state.
   *
   * The two rows above are emitted on the way *into* a decision and there was
   * nothing for the way out, so a trail could say the board adopted the FMV —
   * `approved_at` stamped, `board_resolution_approved` written — and never say
   * that it stopped having, with the row underneath quietly back at 'pending'
   * and `approved_at` cleared. R288 shut the door `addBoardMember` opened; the
   * one `deleteBoardMember` opens is still there (remove the sole director from
   * an approved resolution, or the rejecting director from a rejected one) and
   * cannot be shut the same way, because removing a director is a thing ops is
   * allowed to do. So the move is recorded instead of refused.
   *
   * `critical` and `client`-visible for the same reason its two siblings are:
   * whoever was told the resolution was approved has to be able to see that it
   * no longer is.
   */
  board_resolution_reopened: D('Board resolution reopened', 'review', 'critical', 'client'),
  board_signoff_recorded: D('Board sign-off recorded', 'review', 'critical', 'client'),

  // ── Output & delivery ───────────────────────────────────────────────────
  report_saved: D('Report draft saved', 'output', 'notice'),
  report_reverted: D('Report reverted', 'output', 'critical'),
  report_rendered: D('Report generated', 'output', 'critical', 'client'),
  draft_ready: D('Draft ready for review', 'output', 'notice', 'client'),
  evidence_bundle_exported: D('Evidence bundle exported', 'output', 'notice'),
  /**
   * The deliverable leaving by a door somebody opened.
   *
   * "The export itself is an auditable act" is what the evidence bundle above
   * has said since it was written, and the *report* — the signed 409A itself —
   * left by two other doors that said nothing. Both served the stored bytes
   * straight out: `report_rendered` is written when a version is produced, not
   * when it is read, so a delivered report downloaded fifty times over a year
   * by a client, a partner integration and whoever else held the link produced
   * exactly one row, dated the day it was made.
   *
   * Only the draft path ever recorded a read, and by accident: an unpublished
   * engagement renders a stamped copy per download, so it wrote a render event
   * each time. The published version — the one auditors and boards actually
   * pull — is cached, and the cache hit was the silent path.
   */
  report_downloaded: D('Report downloaded', 'output', 'notice'),
  /*
   * The working papers leaving by the same kind of door.
   *
   * `workbook.xlsx` is the auditor workbook: the assumption register, the
   * three model sheets, the cap table and grant schedules, the flattened
   * engine `results`, and the manual-override log — every value an analyst set
   * by hand, the engine value it replaced and the reason they typed. It is
   * more of the engagement in one file than either of the two exports above,
   * and it recorded nothing, so the trail could show a deliverable being read
   * and not the working papers behind it being taken.
   *
   * `internal`: the route is `canEditWorkingData`, and the file is analyst
   * material rather than anything a client is shown.
   */
  workbook_exported: D('Auditor workbook exported', 'output', 'notice'),

  // The auditor's half of the review round trip. `notice` rather than `info`:
  // it is an outside reviewer putting something on the record about a
  // deliverable, which is the kind of entry a later reader of this trail is
  // looking for. Internal — it is addressed to the engagement team, and the
  // thread it lands in (`email` kind) is ops-visible for the same reason.
  auditor_note_received: D('Auditor note received', 'review', 'notice'),

  // ── Access & integration ────────────────────────────────────────────────
  email_received: D('Email received', 'access', 'info'),
  monitoring_enabled: D('Monitoring enabled', 'integration', 'info', 'client'),
  monitoring_disabled: D('Monitoring disabled', 'integration', 'info', 'client'),
  monitoring_trigger_fired: D('Monitoring trigger fired', 'integration', 'notice', 'client'),
  /**
   * A third party gained, or lost, standing read access to this engagement's
   * data — a payroll system's roster, a cap-table provider's securities, a
   * ledger's financials.
   *
   * Client-visible for the same reason `monitoring_enabled` is, and more so:
   * the thing being connected is the client's own account at another vendor,
   * and the authorisation is granted in their name. Until R256 neither
   * transition was recorded anywhere. The only trace of a connect was
   * `connected_by`/`connected_at` on the row, overwritten by the next one, and
   * a disconnect left no trace of who ended it or when — the row goes on
   * naming the person who *started* it.
   */
  integration_connected: D('Integration connected', 'integration', 'notice', 'client'),
  integration_disconnected: D('Integration disconnected', 'integration', 'notice', 'client'),
  integration_schedule_changed: D('Integration schedule changed', 'integration', 'info', 'client'),
} satisfies Record<string, EventDescriptor>;

/**
 * The event types this build knows how to describe. `recordEvent` accepts
 * nothing else, so every row in `valuation_events` written by this build has a
 * catalog entry.
 */
export type ValuationEventType = keyof typeof EVENT_CATALOG;

/**
 * Every type the platform writes to `admin_events`, and the only ones
 * `recordAdminEvent` will accept.
 *
 * `admin_events` is the second half of the audit spine — the actions that
 * belong to a user, a partner, a prompt or a template rather than to one
 * engagement — and it had no catalog at all. `recordAdminEvent` took
 * `type: string`, and so did the ten route-local `audit(...)` helpers wrapping
 * it, so a typo travelled all the way to the database and came back out the
 * other side as a plausible label: `user_deactivted` renders "User deactivted"
 * through the word-split fallback, sorts beside its correct sibling in the ops
 * feed, and never matches the filter anyone types.

 * Three surfaces printed this vocabulary and none of them had it: the ops
 * activity log showed the raw type in a mono chip, the dashboard feed
 * word-split it, and the same derivation ran a third time in the browser.
 * With a catalog the labels come from one place, `keyof` makes the missing
 * descriptor a compile error at the line that writes it, and the severity and
 * category are available to a feed that has never been able to rank its rows.
 *
 * Visibility is not a field here. Every admin type is an operations action and
 * the feeds that read this table are ops-only — the one exception, the
 * dashboard band's `subject_type = 'valuation'` branch, is dropped whole for
 * non-ops readers rather than filtered type by type.
 */
export const ADMIN_EVENT_CATALOG = {
  // ── Identity & access ───────────────────────────────────────────────────
  user_login: D('User signed in', 'access', 'info'),
  // The half of authentication that was never recorded.
  //
  // A sign-in has been audited since the spine existed; the attempts that did
  // not sign anybody in were counted by an in-memory sliding window and
  // otherwise left no trace anywhere. So the trail could say when a session
  // began and nothing about the four hundred guesses before it, and after a
  // process restart even the counter was gone — an account takeover by
  // credential stuffing and an ordinary Monday morning read identically.
  //
  // A failed password is a `notice`: it is the single most common event on any
  // sign-in page and grading it higher would drown the filter that `critical`
  // exists to serve. A failed *second factor* is `critical`, because reaching
  // that endpoint at all means the password was already correct — the run of
  // rows either side of one of these is what an account takeover looks like
  // from here.
  user_login_failed: D('Sign-in failed', 'access', 'notice'),
  user_mfa_challenge_failed: D('Two-factor verification failed', 'access', 'critical'),
  user_invited: D('User invited', 'access', 'notice'),
  invitation_resent: D('Invitation resent', 'access', 'info'),
  invitation_revoked: D('Invitation revoked', 'access', 'notice'),
  user_created: D('User created', 'access', 'notice'),
  user_updated: D('User updated', 'access', 'notice'),
  user_promoted: D('Role granted', 'access', 'critical'),
  user_demoted: D('Role removed', 'access', 'critical'),
  user_deactivated: D('User deactivated', 'access', 'critical'),
  user_restored: D('User restored', 'access', 'notice'),
  user_password_reset_sent: D('Password reset sent', 'access', 'info'),
  user_sessions_revoked: D('Sessions revoked', 'access', 'notice'),
  user_data_exported: D('Personal data exported', 'access', 'critical'),
  /*
   * The copy that is taken of everybody at once.
   *
   * `user_data_exported` above records one subject's data leaving, at
   * `critical`, from both the admin route and the self-serve one — and
   * `GET /users/export` hands a user administrator a CSV of every account's
   * email address, phone number, name, job title, employer and SSO provider,
   * and recorded nothing at all. So the trail answered "who has taken a copy
   * of this person's data" with the two routes that copy one row and stayed
   * silent about the route that copies all of them, which is the wrong way
   * round: a directory export is the larger disclosure and the one a
   * compromised administrator account reaches for first.
   *
   * `system` rather than `user` as the subject, for the reason the email
   * suppression events use it: there is no one row this is about, and filing
   * it under a subject id would either pick an arbitrary user or put ten
   * thousand rows in ten thousand account trails. The filters and the row
   * count go in the payload, so a reader can tell a partner-scoped slice from
   * the whole directory.
   */
  user_directory_exported: D('User directory exported', 'access', 'critical'),
  account_closed: D('Account closed', 'access', 'critical'),

  // ── Identity & access: the self-serve half ──────────────────────────────
  //
  // Every type above this line is written by an *admin* route and only by one.
  // The platform offers a self-serve equivalent of most of them, and the trail
  // recorded none: an administrator exporting someone's personal data left a
  // `user_data_exported` row, the person exporting their own left nothing;
  // an administrator revoking sessions was recorded, a user revoking their own
  // was not. That is the reverse of what an audit trail is for — the actions
  // an account takes on itself are the ones an account takeover consists of.
  //
  // So the pairs below close the half that was missing, and the credential
  // lifecycle that had no vocabulary at all. `user_created` and `user_login`
  // stay one type each and carry `method` in the payload (`self_service`,
  // `saml_jit`, `scim`) rather than splitting into a type per door: the
  // question a reader asks is "did this account appear, and how", and one type
  // with a discriminator answers it without three labels to keep aligned.
  user_logout: D('User signed out', 'access', 'info'),
  user_password_changed: D('Password changed', 'access', 'critical'),
  user_email_verified: D('Email address verified', 'access', 'info'),
  invitation_accepted: D('Invitation accepted', 'access', 'notice'),
  // Second factor. Enrolment is a `notice`; *removal* is `critical` — turning
  // MFA off is a step in every account takeover that gets that far, and it is
  // the one an owner would want to be asked about afterwards. Regenerating the
  // backup codes invalidates the old set, so it is a credential replacement
  // rather than a read.
  user_mfa_enabled: D('Two-factor authentication enabled', 'access', 'notice'),
  user_mfa_disabled: D('Two-factor authentication disabled', 'access', 'critical'),
  user_mfa_backup_codes_regenerated: D('Backup codes regenerated', 'access', 'notice'),
  // Bearer credentials. A partner API token can read a firm's engagements
  // without a session and outlives the browser that minted it.
  api_token_created: D('API token created', 'access', 'critical'),
  api_token_revoked: D('API token revoked', 'access', 'notice'),
  // Federation. Repointing `saml_config` at another IdP makes every future
  // sign-in that IdP's decision, which is the single highest-leverage write in
  // this schema; a SCIM token is a standing grant to create and deactivate
  // accounts.
  sso_config_updated: D('SSO configuration updated', 'access', 'critical'),
  scim_token_created: D('SCIM token created', 'access', 'critical'),
  scim_token_revoked: D('SCIM token revoked', 'access', 'notice'),

  // ── Partners ────────────────────────────────────────────────────────────
  partner_created: D('Partner created', 'integration', 'notice'),
  partner_updated: D('Partner updated', 'integration', 'notice'),

  // ── Prompts, templates & branding ───────────────────────────────────────
  prompt_updated: D('AI prompt updated', 'methodology', 'critical'),
  prompt_reverted: D('AI prompt reverted', 'methodology', 'critical'),
  narrative_prompt_updated: D('Narrative prompt updated', 'methodology', 'critical'),
  narrative_prompt_reset: D('Narrative prompt reset', 'methodology', 'critical'),
  template_created: D('Report template created', 'output', 'notice'),
  template_updated: D('Report template updated', 'output', 'critical'),
  template_activated: D('Report template activated', 'output', 'critical'),
  template_archived: D('Report template archived', 'output', 'notice'),
  branding_updated: D('Branding updated', 'output', 'notice'),

  // ── Communications ──────────────────────────────────────────────────────
  communication_template_created: D('Communication template created', 'integration', 'notice'),
  communication_template_updated: D('Communication template updated', 'integration', 'notice'),
  communication_template_deleted: D('Communication template deleted', 'integration', 'notice'),
  auto_email_created: D('Automated email created', 'integration', 'notice'),
  auto_email_updated: D('Automated email updated', 'integration', 'notice'),
  auto_email_deleted: D('Automated email deleted', 'integration', 'notice'),
  email_address_suppressed: D('Email address suppressed', 'integration', 'notice'),
  email_suppression_released: D('Email suppression released', 'integration', 'notice'),

  // ── Published content ───────────────────────────────────────────────────
  blog_post_created: D('Blog post created', 'output', 'info'),
  blog_post_updated: D('Blog post updated', 'output', 'info'),
  blog_post_deleted: D('Blog post deleted', 'output', 'notice'),
  help_article_created: D('Help article created', 'output', 'info'),
  help_article_updated: D('Help article updated', 'output', 'info'),
  help_article_deleted: D('Help article deleted', 'output', 'notice'),

  // ── Data governance ─────────────────────────────────────────────────────
  //
  // The whole retention screen wrote nothing here. Setting a policy, placing a
  // legal hold, releasing one, withdrawing an engagement and bringing it back
  // are the five most compliance-relevant actions on this platform — the first
  // decides what gets deleted on a clock, the middle two decide what is exempt
  // from that, and the last two take a client's work out of the product and put
  // it back — and `admin_events` could describe an administrator tidying AI
  // prompts and not any of them.
  //
  // `retention_actions` and the `placed_by`/`released_by` columns carried some
  // of the provenance, but that is a second ledger with a different reader:
  // "what did this administrator do" is asked of the spine, and the answer
  // omitted exactly the actions a reviewer came for. All five are `critical`
  // for the same reason.
  retention_policy_updated: D('Retention policy updated', 'other', 'critical'),
  legal_hold_placed: D('Legal hold placed', 'other', 'critical'),
  legal_hold_released: D('Legal hold released', 'other', 'critical'),
  valuation_retired: D('Engagement withdrawn', 'lifecycle', 'critical'),
  valuation_restored: D('Engagement restored', 'lifecycle', 'critical'),

  // ── Billing & subscriptions ─────────────────────────────────────────────
  //
  // The money surface wrote nothing here. A plan starting, a plan swapped in
  // Stripe's hosted portal, a renewal declining, a subscription ending and an
  // invoice settling were each announced to somebody by email and counted on
  // the ops rollup, and none of them left a row an auditor could read: the
  // trail could describe an administrator editing a help article and not the
  // day an account's entitlement changed.
  //
  // Nearly every one of these arrives from Stripe rather than from a request,
  // so `actor_type` is `system` and `source` is `stripe` — truthfully, because
  // no principal of ours took the action. What makes that attribution readable
  // rather than a dead end is the pair either side of it: `checkout_started`
  // and `billing_portal_opened` name the human who walked into Stripe, and
  // every webhook-written row below carries `stripe_event_id` in its payload,
  // which is the id the Stripe dashboard indexes the same delivery by. Those
  // two are the join between "a person clicked Manage subscription" and "the
  // plan changed an hour later", and without them the second row's actor is
  // the whole answer.
  checkout_started: D('Checkout started', 'integration', 'notice'),
  billing_portal_opened: D('Billing portal opened', 'integration', 'notice'),
  subscription_started: D('Subscription started', 'integration', 'critical'),
  subscription_changed: D('Subscription changed', 'integration', 'critical'),
  subscription_canceled: D('Subscription cancelled', 'integration', 'critical'),
  subscription_payment_failed: D('Subscription payment failed', 'integration', 'critical'),
  invoice_paid: D('Invoice paid', 'integration', 'notice'),
  invoice_refunded: D('Invoice refunded', 'integration', 'critical'),
  // The engagement side of the same ledger. A full refund already reaches the
  // valuation spine, because taking the engagement off `paid` goes through
  // `patchValuation` — but a *partial* refund deliberately leaves the
  // engagement paid, and a chargeback deliberately does not revoke while the
  // case is open, so those two moved money and changed nothing a reader could
  // see. Both are recorded here whatever they do to the engagement: the fact
  // being audited is that money went back out, not that a status followed it.
  payment_refunded: D('Payment refunded', 'integration', 'critical'),
  payment_disputed: D('Payment disputed', 'integration', 'critical'),

  // ── Platform operations ─────────────────────────────────────────────────
  system_settings_updated: D('System settings updated', 'integration', 'critical'),
  job_alert_rule_changed: D('Job alert rule changed', 'integration', 'notice'),
  job_alert_opened: D('Job alert opened', 'integration', 'notice'),
  job_alert_resolved: D('Job alert resolved', 'integration', 'info'),
  data_remediation_rerun: D('Data remediation re-run', 'data', 'notice'),

  // ── Inbound queues ──────────────────────────────────────────────────────
  //
  // Triage was the last operations surface writing nothing here. Both queues
  // record who closed a row in a pair of columns *on the row*, and both clear
  // that pair on the way back — so reopening was an action with no trace
  // anywhere, and the state it left could not say it had ever been closed.
  //
  // `info` on the way in and `notice` on the way back out, for the reason the
  // billing types are graded that way: closing a queue item is the ordinary
  // motion of working it, and undoing somebody else's close is the one a
  // reader is looking for.
  support_message_resolved: D('Support message resolved', 'integration', 'info'),
  support_message_reopened: D('Support message reopened', 'integration', 'notice'),
  contact_submission_handled: D('Contact submission handled', 'integration', 'info'),
  contact_submission_reopened: D('Contact submission reopened', 'integration', 'notice'),

  // ── Analyst actions on one engagement ───────────────────────────────────
  comparable_added: D('Comparable added', 'analysis', 'critical'),
  comparable_deleted: D('Comparable deleted', 'analysis', 'critical'),
  comparable_included: D('Comparable included', 'analysis', 'critical'),
  comparable_excluded: D('Comparable excluded', 'analysis', 'critical'),
  comparables_screened: D('Comparable set screened', 'analysis', 'notice'),
  comparables_refreshed: D('Comparable market data refreshed', 'analysis', 'notice'),
  comparables_ai_applied: D('AI comparables applied', 'analysis', 'critical'),
  volatility_estimated: D('Volatility estimated', 'analysis', 'notice'),
  volatility_applied: D('Volatility applied', 'analysis', 'critical'),
  projection_run: D('Projection run', 'analysis', 'notice'),
  projection_applied: D('Projection applied', 'analysis', 'critical'),
  rollforward_run: D('Roll-forward run', 'analysis', 'notice'),
  rollforward_applied: D('Roll-forward applied', 'analysis', 'critical'),
  market_research_run: D('Market research run', 'analysis', 'info'),
  cap_table_anonymized: D('Cap table anonymised', 'data', 'notice'),
  documents_refiled: D('Documents re-filed', 'documents', 'notice'),
  valuation_tagged: D('Valuation tagged', 'other', 'info'),
  valuation_tag_decided: D('Valuation tag decided', 'other', 'info'),
  valuation_tag_removed: D('Valuation tag removed', 'other', 'info'),
  valuation_tags_ai_applied: D('AI tags applied', 'other', 'info'),
} as const satisfies Record<string, EventDescriptor>;

/**
 * The admin types this build knows how to describe. `recordAdminEvent` and
 * every route-local audit helper take this union rather than `string`.
 */
export type AdminEventType = keyof typeof ADMIN_EVENT_CATALOG;

/**
 * Still needed, and not as a formality: the spine is append-only and older
 * rows carry types this build has since renamed or retired. A trail that
 * refuses to render them would be worse than one that names them vaguely.
 */
const UNKNOWN_EVENT: EventDescriptor = D('Event recorded', 'other', 'info');

/**
 * Every event type a reader outside operations may see, derived from the
 * `visibility` beside each descriptor rather than listed again here.
 *
 * The catalog has said which events are analyst tooling since it was written,
 * and exactly one door applied it: `filterAuditEntries`, for the audit-trail
 * route. Three other routes read the same spine — the progress timeline with
 * its own small allow-list, the evidence bundle and the engagement panel behind
 * ops-only guards — and `GET /valuations/:id/events` with neither. A client who
 * owned the engagement could read `overwrite_applied`, `review_decision`,
 * `qa_review_completed` and every internal `comment_added`, payloads included:
 * 37 of the catalog's 66 types, on a route whose neighbours all gate them.
 *
 * Exported as a type list so the rule can be pushed into SQL. Filtering the
 * rows after a `LIMIT` would hand a client a short page and call it the newest
 * N; `listEvents({ types })` asks the database the question the reader is
 * actually allowed to ask, and the (type) index from 0047 serves it.
 */
export const CLIENT_VISIBLE_EVENT_TYPES: readonly ValuationEventType[] = Object.entries(EVENT_CATALOG)
  .filter(([, descriptor]) => descriptor.visibility === 'client')
  .map(([type]) => type as ValuationEventType);

/** Catalog lookup that never throws — unknown types degrade to a safe default. */
export function describeEventType(type: string): EventDescriptor {
  return (EVENT_CATALOG as Record<string, EventDescriptor>)[type] ?? UNKNOWN_EVENT;
}

/**
 * The one place an event type becomes English.
 *
 * Three surfaces printed this vocabulary and each had its own copy of it. The
 * change log read the catalog; the valuation timeline and the dashboard feed
 * read a hand-written map in the frontend that had drifted — the same row was
 * "Stage changed" on one screen and "State changed" on the next, "Report
 * generated" here and "Report PDF rendered" there, "Analyst overwrite applied"
 * against "Override applied". Nothing was wrong enough to report and all of it
 * was the same event.
 *
 * So the label travels with the row now, from here — for both tables. The
 * word-split fallback stays, because the spine is append-only and older rows
 * carry types this build has since renamed: an uncatalogued type is
 * word-split rather than flattened to `describeEventType`'s "Event recorded",
 * since "Partner updated" says more than that, and the derivation is the same
 * one `humanizeField` uses on field names, initialisms included. What it is no
 * longer doing is naming the *current* vocabulary — `admin_events` had no
 * catalog until R128, so every one of its 64 types reached a reader through
 * this line.
 */
export function eventLabel(type: string): string {
  const described =
    (EVENT_CATALOG as Record<string, EventDescriptor>)[type] ??
    (ADMIN_EVENT_CATALOG as Record<string, EventDescriptor>)[type];
  return described?.label ?? humanizeField(type);
}

// ── Field-level change extraction ─────────────────────────────────────────

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** True for `{ from, to }` change records as written by patch helpers. */
function isChangeRecord(value: unknown): value is { from?: unknown; to?: unknown } {
  return typeof value === 'object' && value !== null && ('from' in value || 'to' in value);
}

/**
 * Diff two records over an allow-list of columns, producing exactly the
 * `{ field: { from, to } }` payload shape the patch helpers record. Values are
 * compared with `!==`, matching how the SQL patch builders decide what to write.
 */
export function diffRecords(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  columns: readonly string[],
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const column of columns) {
    if (!(column in after)) continue;
    if (before[column] === after[column]) continue;
    changes[column] = { from: before[column] ?? null, to: after[column] };
  }
  return changes;
}

/**
 * Normalise the payload shapes we write into one flat change list:
 *   - `{ changes: { field: { from, to } } }` — patchValuation / patchParams
 *   - `{ from, to }`                          — state_changed
 *   - `{ engine_inputs_applied: { … } }`      — AI extraction auto-apply
 *   - `{ fields: ['a', 'b'] }`                — grants and friends (names only)
 * Anything else yields an empty list rather than guessing.
 */
export function extractChanges(type: string, payload: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];

  const nested = payload.changes;
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    for (const [field, value] of Object.entries(nested as Record<string, unknown>)) {
      if (isChangeRecord(value)) {
        changes.push({ field, from: value.from ?? null, to: value.to ?? null });
      } else {
        changes.push({ field, from: null, to: value });
      }
    }
  }

  if (changes.length === 0 && ('from' in payload || 'to' in payload)) {
    const field = type === 'state_changed' ? 'state' : 'value';
    changes.push({ field, from: payload.from ?? null, to: payload.to ?? null });
  }

  const applied = payload.engine_inputs_applied;
  if (typeof applied === 'object' && applied !== null && !Array.isArray(applied)) {
    for (const [field, value] of Object.entries(applied as Record<string, unknown>)) {
      changes.push({ field: `engine_inputs.${field}`, from: null, to: value });
    }
  }

  if (changes.length === 0 && Array.isArray(payload.fields)) {
    for (const field of payload.fields) {
      if (typeof field === 'string') changes.push({ field, from: null, to: null });
    }
  }

  return changes;
}

/** Compact, human-readable rendering of a value for audit summaries. */
export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return ellipsize(value, 80);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  return 'updated';
}

/** Field name → the words a reader expects (`dlom` → `DLOM`). */
export function humanizeField(field: string): string {
  const [prefix, ...rest] = field.split('.');
  const leaf = rest.length > 0 ? rest.join('.') : prefix!;
  const words = leaf
    .replace(/_cents$/, '')
    .split('_')
    .filter(Boolean)
    .map((w) => (/^(dlom|dloc|opm|qsbs|ytd|ai|qa|id)$/i.test(w) ? w.toUpperCase() : w));
  if (words.length === 0) return field;
  const first = words[0]!;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

/** One-line summary of what an event changed, for timelines and PDF exports. */
export function summarizeChanges(changes: readonly FieldChange[], max = 3): string {
  if (changes.length === 0) return '';
  const shown = changes.slice(0, max).map((c) => {
    const name = humanizeField(c.field);
    if (c.from === null && c.to === null) return name;
    if (c.from === null || c.from === undefined) return `${name} set to ${formatAuditValue(c.to)}`;
    return `${name}: ${formatAuditValue(c.from)} → ${formatAuditValue(c.to)}`;
  });
  const extra = changes.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ');
}

// ── Enriched entries ──────────────────────────────────────────────────────

export interface RawAuditEvent {
  id: string;
  seq: string;
  type: string;
  actor_type: string;
  actor_id: string | null;
  source: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export interface AuditEntry extends EventDescriptor {
  id: string;
  seq: string;
  type: string;
  actor_type: string;
  actor_id: string | null;
  source: string | null;
  changes: FieldChange[];
  summary: string;
  occurred_at: Date;
}

/** Raw spine row → enriched, renderable audit entry. */
export function describeEvent(event: RawAuditEvent): AuditEntry {
  const descriptor = describeEventType(event.type);
  const changes = extractChanges(event.type, event.payload ?? {});
  return {
    id: event.id,
    seq: event.seq,
    type: event.type,
    ...descriptor,
    actor_type: event.actor_type,
    actor_id: event.actor_id,
    source: event.source,
    changes,
    summary: summarizeChanges(changes),
    occurred_at: event.occurred_at,
  };
}

export interface AuditFilters {
  category?: EventCategory;
  severity?: EventSeverity;
  actorType?: string;
  type?: string;
  field?: string;
  from?: Date;
  to?: Date;
  /** Non-ops callers only ever see client-visible events. */
  includeInternal: boolean;
}

/** Apply the visibility rule and every optional filter, newest first. */
export function filterAuditEntries(entries: readonly AuditEntry[], filters: AuditFilters): AuditEntry[] {
  return entries
    .filter((e) => {
      if (!filters.includeInternal && e.visibility !== 'client') return false;
      if (filters.category && e.category !== filters.category) return false;
      if (filters.severity && e.severity !== filters.severity) return false;
      if (filters.actorType && e.actor_type !== filters.actorType) return false;
      if (filters.type && e.type !== filters.type) return false;
      if (filters.field && !e.changes.some((c) => c.field === filters.field)) return false;
      if (filters.from && e.occurred_at < filters.from) return false;
      if (filters.to && e.occurred_at > filters.to) return false;
      return true;
    })
    .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime() || (a.seq < b.seq ? 1 : -1));
}

export interface AuditSummary {
  total: number;
  by_category: Record<string, number>;
  by_severity: Record<string, number>;
  by_actor_type: Record<string, number>;
  critical_changes: number;
  changed_fields: string[];
  first_at: Date | null;
  last_at: Date | null;
}

/** Roll-up used by the audit-trail header and the evidence bundle cover page. */
export function summarizeAuditTrail(entries: readonly AuditEntry[]): AuditSummary {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byActor: Record<string, number> = {};
  const fields = new Set<string>();
  let critical = 0;
  let first: Date | null = null;
  let last: Date | null = null;

  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
    bySeverity[entry.severity] = (bySeverity[entry.severity] ?? 0) + 1;
    byActor[entry.actor_type] = (byActor[entry.actor_type] ?? 0) + 1;
    if (entry.severity === 'critical') critical += 1;
    for (const change of entry.changes) fields.add(change.field);
    if (first === null || entry.occurred_at < first) first = entry.occurred_at;
    if (last === null || entry.occurred_at > last) last = entry.occurred_at;
  }

  return {
    total: entries.length,
    by_category: byCategory,
    by_severity: bySeverity,
    by_actor_type: byActor,
    critical_changes: critical,
    changed_fields: [...fields].sort(),
    first_at: first,
    last_at: last,
  };
}

/**
 * Per-field change history, newest first — answers "how did DLOM get to 22%?"
 * in one lookup instead of scanning the whole timeline.
 */
export function fieldHistory(
  entries: readonly AuditEntry[],
  field: string,
): Array<FieldChange & { at: Date; actor_type: string; actor_id: string | null; type: string }> {
  const history: Array<
    FieldChange & { at: Date; actor_type: string; actor_id: string | null; type: string }
  > = [];
  for (const entry of entries) {
    for (const change of entry.changes) {
      if (change.field !== field) continue;
      history.push({
        ...change,
        at: entry.occurred_at,
        actor_type: entry.actor_type,
        actor_id: entry.actor_id,
        type: entry.type,
      });
    }
  }
  return history.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * Flat change log: one row per field that moved, across the whole spine.
 * events.json is the authoritative record but it is nested JSON; an auditor
 * scanning for "when did the DLOM change and who signed off?" wants a table
 * they can open in Excel and sort. Same data, readable shape.
 */
export function changeLogCsv(entries: readonly AuditEntry[]): string {
  const rows = entries.flatMap((entry) =>
    entry.changes.map((change) => [
      entry.occurred_at,
      entry.seq,
      entry.type,
      entry.label,
      entry.category,
      entry.severity,
      entry.actor_type,
      entry.actor_id ?? '',
      entry.source ?? '',
      change.field,
      humanizeField(change.field),
      formatAuditValue(change.from),
      formatAuditValue(change.to),
    ]),
  );
  return toCsv(
    [
      'occurred_at',
      'seq',
      'event_type',
      'event',
      'category',
      'severity',
      'actor_type',
      'actor_id',
      'source',
      'field',
      'field_label',
      'from',
      'to',
    ],
    rows,
  );
}
