import type pg from 'pg';

/**
 * A copy of everything this platform holds about one person (GDPR Art. 15 /
 * UK GDPR, and the promise the privacy page already made — "request a copy or
 * deletion of your personal data at any time").
 *
 * Deletion was self-serve (`DELETE /api/v1/me`); the copy was not, and there
 * was no mechanism behind the sentence at all. An access request arriving by
 * email had to be answered by somebody with a psql prompt, which is how the
 * one-month statutory deadline gets missed and how the answer ends up being
 * whichever tables that person thought of.
 *
 * Two decisions worth stating, because they are what makes this an export
 * rather than a database dump:
 *
 * **What is a person's data here.** The account itself, the records they
 * authored (comments, support tickets, uploads, API tokens, saved views), the
 * things addressed to them (notifications, mentions, and every message the
 * platform actually sent to their address), what they put their name to
 * (report signatures), the devices they told us to trust, and the commercial
 * relationship (engagements, payments, invoices, subscription). Not the
 * valuation *content*: a 409A's cap table, projections and comparables are the
 * company's data, they are already downloadable per engagement through the
 * evidence bundle and the exports, and copying them here would turn an access
 * request into a second, unaudited route to the deliverable.
 *
 * Two sections reach the subject through their *address* rather than their
 * primary key, and both are there because the census (`personalDataCensus`)
 * learned to read contact columns as well as foreign keys: a table that
 * identifies a person by email is invisible to a scan for FKs to `users`, and
 * five such tables had never been considered at all.
 * `contact_submissions` is what somebody typed into the public contact form —
 * their name, address, phone and message, held under no account and reachable
 * from nowhere else. `user_invitations` is who invited them, when, to what
 * role, and whether it lapsed; "how did I come to have an account here" is a
 * question only that row answers.
 *
 * "The messages the platform sent them" used to mean the in-app notification
 * list alone, which is the smaller half — the mail is where the platform says
 * most of what it says to a person, and `email_outbox` holds the subject and
 * body of every one of them. Its delivery state belongs here too, including
 * the suppression list: an address that hard-bounced stops receiving service
 * mail entirely, and "why did I stop hearing from you" is a question only that
 * row answers. `email_suppressions` is keyed by the address rather than by a
 * user id, so it is the one section that reaches the subject through their
 * email rather than their primary key.
 *
 * The audit spine is in the copy for the rows it is *about* the requester —
 * `admin_events` where `subject_type = 'user'` and the subject is them. That
 * is a narrower thing than "the audit trail", and the line is the same one
 * `user_invitations` sits on: what a person did to a valuation belongs to the
 * engagement, what was done *to their account* belongs to them. An account
 * provisioned, deactivated or restored by a directory connector over SCIM is
 * the case where the subject took none of the actions and had no way to see
 * any of them.
 *
 * **What is deliberately withheld.** The password digest, the TOTP secret and
 * its backup codes, the API token hashes, and the reset/verification tokens.
 * Article 15(4) is explicit that the right to a copy must not adversely affect
 * others, and a credential is the case where a copy *is* the harm: an export
 * that quotes the second factor is a second factor that no longer works. Each
 * is reported as present rather than omitted silently, so the export does not
 * misrepresent what is held.
 *
 * Every section is capped and says when the cap bit. An export that silently
 * stops at 500 rows is a worse answer to a statutory request than one that says
 * it is incomplete.
 */

/** Rows per section. Generous enough that a real account is never truncated. */
export const EXPORT_SECTION_LIMIT = 2000;

export interface ExportSection<T> {
  rows: T[];
  truncated: boolean;
}

type ExportRow = Record<string, unknown>;

/**
 * One capped section. The limit is appended as the last bind parameter, and one
 * row over it is fetched so the cap can report itself rather than being
 * indistinguishable from an account that happens to have exactly that many.
 */
async function section(
  pool: pg.Pool,
  sql: string,
  params: readonly unknown[],
): Promise<ExportSection<ExportRow>> {
  const { rows } = await pool.query<ExportRow>(sql, [...params, EXPORT_SECTION_LIMIT + 1]);
  return { rows: rows.slice(0, EXPORT_SECTION_LIMIT), truncated: rows.length > EXPORT_SECTION_LIMIT };
}

export interface PersonalDataExport {
  generated_at: string;
  subject_user_id: string;
  account: Record<string, unknown> | null;
  /** Named, not quoted — see the note above on credentials. */
  withheld: { field: string; held: boolean; reason: string }[];
  engagements: ExportSection<Record<string, unknown>>;
  comments: ExportSection<Record<string, unknown>>;
  documents_uploaded: ExportSection<Record<string, unknown>>;
  notifications: ExportSection<Record<string, unknown>>;
  notification_preferences: ExportSection<Record<string, unknown>>;
  /** Mail actually sent to them: subject, body, and what became of it. */
  emails_sent: ExportSection<Record<string, unknown>>;
  /** Their address on the bounce/complaint list, if it is on it. */
  email_suppression: ExportSection<Record<string, unknown>>;
  /** What they sent through the public contact form, before any account. */
  contact_submissions: ExportSection<Record<string, unknown>>;
  /** Invitations addressed to them: who, when, to what role, what became of it. */
  invitations: ExportSection<Record<string, unknown>>;
  mentions: ExportSection<Record<string, unknown>>;
  /** When they last looked at each engagement's discussion. */
  comment_reads: ExportSection<Record<string, unknown>>;
  saved_views: ExportSection<Record<string, unknown>>;
  signatures: ExportSection<Record<string, unknown>>;
  /** Metadata only; the device token is a credential — see `withheld`. */
  trusted_devices: ExportSection<Record<string, unknown>>;
  support_messages: ExportSection<Record<string, unknown>>;
  payments: ExportSection<Record<string, unknown>>;
  invoices: ExportSection<Record<string, unknown>>;
  subscriptions: ExportSection<Record<string, unknown>>;
  api_tokens: ExportSection<Record<string, unknown>>;
  /** The account's own lifecycle out of the audit spine — see the query. */
  account_events: ExportSection<Record<string, unknown>>;
  section_limit: number;
}

/**
 * Assemble the export for one user.
 *
 * Authorization is the caller's job — this function exports whatever id it is
 * given, and the route is what decides that a person may only ask for their
 * own (or that a user admin may ask on their behalf, which is how a request
 * arriving by email gets answered).
 */
export async function buildPersonalDataExport(pool: pg.Pool, userId: string): Promise<PersonalDataExport> {
  // The account, minus every credential. Enumerated rather than `SELECT *`
  // with deletions, so a column added later is absent by default instead of
  // being exported by an oversight.
  //
  // "Absent by default" is the safe direction for a credential and the wrong
  // one for an identifier, and nothing said which a new column was. The table
  // census below this file (`personalDataCensus`) states the rule one level up
  // — every *table* about a person is exported or exempted — and stopped
  // there, so two columns on the most personal table in the schema had never
  // been considered by anything:
  //
  //   * `gclid` is the Google Ads click identifier captured at signup. It is
  //     an online identifier under Art. 4(1) in the plainest sense — it ties
  //     this account to one advertisement click, which is a fact about the
  //     person that exists nowhere else and that they cannot see.
  //   * `scim_external_id` is the id their employer's directory knows them by,
  //     written here by the SCIM connector (routes/scim.ts) and round-tripped
  //     back to it. An account provisioned by an IdP is the case where the
  //     subject did not create the record and has the least idea what is in
  //     it.
  //
  // `usersColumnCensus.test.ts` now holds every column of `users` against this
  // list or against a written reason, so the next one is a decision.
  const { rows: accountRows } = await pool.query<Record<string, unknown>>(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.job_title, u.company_name,
            u.timezone, u.verified, u.sso_provider, u.provisioned_by, u.scim_external_id,
            u.gclid, u.partner_id,
            u.totp_enabled, u.totp_confirmed_at, u.created_at, u.deleted_at,
            p.name AS partner_name,
            coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
       FROM users u
       LEFT JOIN partners p ON p.id = u.partner_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.id = $1
      GROUP BY u.id, p.name`,
    [userId],
  );
  const account = accountRows[0] ?? null;

  const { rows: heldRows } = await pool.query<{
    has_password: boolean;
    has_totp: boolean;
    backup_codes: string;
    api_tokens: string;
    trusted_devices: string;
  }>(
    `SELECT (u.password_digest IS NOT NULL) AS has_password,
            (u.totp_secret IS NOT NULL) AS has_totp,
            (SELECT count(*) FROM mfa_backup_codes b WHERE b.user_id = u.id) AS backup_codes,
            (SELECT count(*) FROM api_tokens t WHERE t.created_by = u.id) AS api_tokens,
            (SELECT count(*) FROM mfa_trusted_devices d WHERE d.user_id = u.id) AS trusted_devices
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  const held = heldRows[0];
  const withheld = [
    {
      field: 'password_digest',
      held: held?.has_password ?? false,
      reason: 'A credential. Change it from Settings; it is never readable, here or anywhere.',
    },
    {
      field: 'totp_secret',
      held: held?.has_totp ?? false,
      reason: 'The second-factor seed. Exporting it would be exporting the second factor.',
    },
    {
      field: 'mfa_backup_codes',
      held: Number(held?.backup_codes ?? 0) > 0,
      reason: 'Single-use recovery codes, stored hashed. Regenerate them from Settings.',
    },
    {
      field: 'api_token_secrets',
      held: Number(held?.api_tokens ?? 0) > 0,
      reason: 'Stored as a SHA-256 hash and shown once at creation. The tokens are listed without them.',
    },
    {
      field: 'trusted_device_tokens',
      held: Number(held?.trusted_devices ?? 0) > 0,
      reason:
        'The cookie value that lets a device skip the second factor, stored hashed. ' +
        'Exporting it would export the skip. The devices themselves are listed.',
    },
  ];

  const [
    engagements,
    comments,
    documentsUploaded,
    notifications,
    notificationPreferences,
    emailsSent,
    emailSuppression,
    contactSubmissions,
    invitations,
    mentions,
    commentReads,
    savedViews,
    signatures,
    trustedDevices,
    supportMessages,
    payments,
    invoices,
    subscriptions,
    apiTokens,
    accountEvents,
  ] = await Promise.all([
    // Their engagements as a relationship — what was ordered, when, what it
    // cost, where it got to. Not the valuation's contents; see the note above.
    section(
      pool,
      `SELECT id, number, kind, company_name, state, currency, source, paid_status, amount_cents,
              paid_at, created_at, completed_at, published_at, due_date, archived_at
         FROM valuations WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId],
    ),
    section(
      pool,
      `SELECT id, valuation_id, kind, body, pinned, created_at, updated_at
         FROM valuation_comments WHERE author_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId],
    ),
    // Metadata only. The files themselves are per-engagement and downloadable
    // there; a blob in a JSON export is a copy nobody asked for and one more
    // place a client's financials exist.
    section(
      pool,
      `SELECT id, valuation_id, filename, kind, category, content_type, size_bytes, sha256,
              created_at, deleted_at
         FROM documents WHERE uploaded_by = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId],
    ),
    section(
      pool,
      `SELECT id, valuation_id, type, title, body, link, read_at, created_at
         FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId],
    ),
    section(
      pool,
      `SELECT event_type, in_app, email, updated_at
         FROM notification_preferences WHERE user_id = $1 ORDER BY event_type LIMIT $2`,
      [userId],
    ),
    // Every message the platform put in their inbox, with the text it sent and
    // what became of it. The body is included rather than summarised: it was
    // addressed to this person and they already have a copy of it, so quoting
    // it back is the one place where an export is unambiguously theirs to have.
    // `to_email` is included because it records which address a given message
    // actually went to, which a changed address makes non-obvious.
    section(
      pool,
      `SELECT id, valuation_id, channel::text AS channel, to_email, template_key, subject, body,
              status::text AS status, promotional, attempts, created_at, sent_at, delivered_at,
              bounced_at, bounce_kind::text AS bounce_kind, bounce_detail,
              first_opened_at, last_opened_at, open_count
         FROM email_outbox WHERE to_user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId],
    ),
    // Keyed by address, not by user id — so this reaches the subject through
    // their email. At most one row, but shaped as a section like the rest so a
    // reader does not have to learn a second convention for one field.
    //
    // `released_by` is deliberately not selected: it names the *operator* who
    // lifted the suppression, which is another person's data and Art. 15(4)'s
    // exact concern. That the release happened is the subject's business; who
    // did it is the audit trail's.
    //
    // `s.to_email` is compared bare against `lower(u.email)` rather than being
    // folded itself: `email_suppressions.to_email` is the primary key and every
    // write to it goes through `normalizeAddress`, so it is already lowercase.
    // Wrapping it in `lower()` would be a no-op that no index can see, turning
    // a primary-key lookup into a scan of the whole suppression list.
    section(
      pool,
      `SELECT s.to_email, s.reason::text AS reason, s.detail, s.created_at, s.released_at
         FROM email_suppressions s
         JOIN users u ON s.to_email = lower(u.email)
        WHERE u.id = $1 ORDER BY s.created_at DESC LIMIT $2`,
      [userId],
    ),
    // The public contact form. `contact_submissions` has no user id — the form
    // is unauthenticated by design — so it is reached the same way the
    // suppression list is, by matching the address. It holds a name, an
    // address, a phone number and free text somebody wrote about themselves,
    // which makes it some of the most plainly personal data in the schema, and
    // it was in no access request because nothing joined it to an account.
    //
    // `handled_by` and `handled_at` are not selected: who in operations picked
    // the message up is another person's data, the same call `email_suppression`
    // makes about `released_by`.
    section(
      pool,
      `SELECT c.id, c.name, c.email, c.company, c.phone, c.message,
              c.status::text AS status, c.created_at
         FROM contact_submissions c
         JOIN users u ON lower(c.email) = lower(u.email)
        WHERE u.id = $1 ORDER BY c.created_at DESC LIMIT $2`,
      [userId],
    ),
    // How they came to have an account, when it was offered and what became of
    // it. Also addressed by email — an invitation exists before the account
    // does, so it cannot be keyed on one.
    //
    // `token_sha256` is a live capability to take over the invited seat while
    // the invitation is open, and is excluded for the reason the reset token is
    // (Art. 15(4)); `invited_by` names another person and stays in the audit
    // trail. `roles` is included because "what access was I offered" is about
    // the subject.
    section(
      pool,
      `SELECT i.id, i.email, i.roles, i.expires_at, i.created_at, i.accepted_at, i.revoked_at
         FROM user_invitations i
         JOIN users u ON lower(i.email) = lower(u.email)
        WHERE u.id = $1 ORDER BY i.created_at DESC LIMIT $2`,
      [userId],
    ),
    // Being named in someone else's comment is a record about this person that
    // they did not author, which is precisely the kind Art. 15 exists for. The
    // comment body is not quoted: it is another person's writing, and the
    // engagement it hangs off is the pointer that makes it findable.
    section(
      pool,
      `SELECT m.comment_id, m.task_id, m.created_at, c.valuation_id
         FROM comment_mentions m JOIN valuation_comments c ON c.id = m.comment_id
        WHERE m.user_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
      [userId],
    ),
    // "When you last looked at this engagement" is behavioural data about a
    // person rather than about the engagement, so there is no honest way to
    // call it out of scope. One row per engagement they can see, so it is
    // bounded by the same thing the engagements section is.
    section(
      pool,
      `SELECT valuation_id, last_read_at
         FROM valuation_comment_reads WHERE user_id = $1 ORDER BY last_read_at DESC LIMIT $2`,
      [userId],
    ),
    section(
      pool,
      `SELECT id, name, query, visibility, is_default, created_at, updated_at
         FROM saved_views WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId],
    ),
    // What they put their name to. `signature_text` is the typed name that
    // stands in for a wet signature, and a person is entitled to a copy of the
    // thing that was recorded as their signature.
    section(
      pool,
      `SELECT id, valuation_id, role::text AS role, signer_name, signer_title,
              signature_text, signed_at
         FROM valuation_signatures WHERE signer_user_id = $1 ORDER BY signed_at DESC LIMIT $2`,
      [userId],
    ),
    // Metadata only; `token_hash` is the credential and is reported in
    // `withheld` instead. Expired rows are included on purpose — the export
    // answers what is held, and a row the sweep has not reached yet is held.
    section(
      pool,
      `SELECT id, label, expires_at, created_at, last_used_at
         FROM mfa_trusted_devices WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId],
    ),
    section(
      pool,
      `SELECT id, subject, body, page_path, status, created_at, resolved_at
         FROM support_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId],
    ),
    // Money that moved. Keyed on the engagement's owner rather than on who
    // clicked pay, because ops open checkouts on a client's behalf and the
    // client is who the payment is about.
    //
    // `settled_at` is exported alongside the other dated facts rather than
    // explained away with `updated_at`: it is when the money actually landed,
    // which is what the subject's receipt is dated from, and it is a different
    // day from `created_at` whenever a payment was not instant.
    section(
      pool,
      `SELECT p.id, p.valuation_id, p.provider, p.amount_cents, p.currency, p.status,
              p.refunded_cents, p.refunded_at, p.dispute_status, p.disputed_at, p.receipt_url,
              p.express, p.qsbs_letter, p.price_breakdown, p.settled_at, p.created_at
         FROM payments p JOIN valuations v ON v.id = p.valuation_id
        WHERE v.user_id = $1 ORDER BY p.created_at DESC LIMIT $2`,
      [userId],
    ),
    /*
     * The invoice as it stands, including what came back off it.
     *
     * `refunded_cents` and `refunded_at` (migration 0169) were added to both
     * `payments` and `invoices` and reached only the payments section here, so
     * the same refund was in the copy when it was taken against a one-off
     * engagement fee and absent when it was taken against a subscription
     * invoice — a difference in what a person is told about their own money
     * that nothing chose. `subscription_id` joins the row to the subscription
     * section beside it, and `created_at` is when the record was made as
     * against `issued_at`, which the platform can set later.
     */
    section(
      pool,
      `SELECT id, number, subscription_id, amount_cents, currency, status, period_start, period_end,
              line_items, refunded_cents, refunded_at, issued_at, paid_at, created_at
         FROM invoices WHERE user_id = $1 ORDER BY issued_at DESC LIMIT $2`,
      [userId],
    ),
    /*
     * `cancel_at_period_end` (migration 0187) is the answer to "is this ending"
     * for the whole window between asking and the date it happens — the state
     * R213 added precisely because a cancelled subscription otherwise reads
     * `active` with no end in sight. `canceled_at` alone answers it only after
     * the fact.
     *
     * `quota_period_start` (migration 0190) is which period `valuations_used`
     * is counting, which is not always `current_period_start` — a renewal that
     * has not been paid for moves the period and leaves the counter where it
     * was. Without it the two figures beside each other say a customer has used
     * n valuations of a period they cannot have used them in.
     */
    section(
      pool,
      `SELECT id, plan_tier, status, valuations_used, quota_period_start,
              current_period_start, current_period_end,
              cancel_at_period_end, canceled_at, created_at
         FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId],
    ),
    // Prefix and metadata; never token_hash.
    section(
      pool,
      `SELECT id, name, token_prefix, partner_id, created_at, last_used_at, revoked_at
         FROM api_tokens WHERE created_by = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId],
    ),
    /*
     * What happened to this account, from the audit spine.
     *
     * The doctrine above draws a line at the audit trail and that line is
     * right where it is drawn — what a person *did* to a valuation is the
     * engagement's record, not theirs, and copying it here would put a
     * client's working papers into an access request by the back door. But
     * `admin_events` is polymorphic, and the rows whose `subject_type` is
     * `'user'` are on the other side of that line: the subject of the row is
     * the person asking. They are the same class of fact as `user_invitations`
     * — which is exported for the stated reason that "how did I come to have
     * an account here" is a question only that row answers.
     *
     * The case that makes it unarguable is the one this round came for. An
     * account provisioned over SCIM was created by a directory connector, may
     * be deactivated by it, and may be reactivated by it, and the person it
     * belongs to did none of those things and is told about none of them. The
     * three `recordAdminEvent` calls in `routes/scim.ts` are the *only* record
     * that any of it happened, and until now they were readable by
     * administrators and by nobody else. Same for a SAML JIT account, and for
     * a promotion or demotion an administrator performed.
     *
     * No table was invisible here, which is why the table census never asked:
     * `admin_events.subject_id` carries no foreign key — it cannot, being
     * polymorphic over users, partners, invitations and templates — so a scan
     * for columns pointing at `users` sees nothing, and `subject_label` is not
     * spelled like a contact column either.
     *
     * `actor_id` is deliberately not selected, and that is the same call
     * `email_suppression` makes about `released_by` and `contact_submissions`
     * about `handled_by`: which administrator carried the action out is
     * another person's data, and Art. 15(4) is the limit on answering one
     * person's request with another's. `actor_type` and `source` are: "a
     * person", "the system", "scim" is what the subject actually needs to
     * know, and it names nobody.
     *
     * `subject_id` leads the predicate so the index added in 0184 serves it —
     * `admin_events_subject_idx` is `(subject_type, subject_id)`, whose
     * leading column has about six distinct values in the whole table and
     * therefore reaches nothing.
     */
    section(
      pool,
      `SELECT type, actor_type::text AS actor_type, source, payload, occurred_at
         FROM admin_events WHERE subject_id = $1 AND subject_type = 'user'
        ORDER BY occurred_at DESC LIMIT $2`,
      [userId],
    ),
  ]);

  return {
    generated_at: new Date().toISOString(),
    subject_user_id: userId,
    account,
    withheld,
    engagements,
    comments,
    documents_uploaded: documentsUploaded,
    notifications,
    notification_preferences: notificationPreferences,
    emails_sent: emailsSent,
    email_suppression: emailSuppression,
    contact_submissions: contactSubmissions,
    invitations,
    mentions,
    comment_reads: commentReads,
    saved_views: savedViews,
    signatures,
    trusted_devices: trustedDevices,
    support_messages: supportMessages,
    payments,
    invoices,
    subscriptions,
    api_tokens: apiTokens,
    account_events: accountEvents,
    section_limit: EXPORT_SECTION_LIMIT,
  };
}
