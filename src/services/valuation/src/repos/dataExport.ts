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
  mentions: ExportSection<Record<string, unknown>>;
  saved_views: ExportSection<Record<string, unknown>>;
  signatures: ExportSection<Record<string, unknown>>;
  /** Metadata only; the device token is a credential — see `withheld`. */
  trusted_devices: ExportSection<Record<string, unknown>>;
  support_messages: ExportSection<Record<string, unknown>>;
  payments: ExportSection<Record<string, unknown>>;
  invoices: ExportSection<Record<string, unknown>>;
  subscriptions: ExportSection<Record<string, unknown>>;
  api_tokens: ExportSection<Record<string, unknown>>;
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
  const { rows: accountRows } = await pool.query<Record<string, unknown>>(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.job_title, u.company_name,
            u.timezone, u.verified, u.sso_provider, u.provisioned_by, u.partner_id,
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
    mentions,
    savedViews,
    signatures,
    trustedDevices,
    supportMessages,
    payments,
    invoices,
    subscriptions,
    apiTokens,
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
      `SELECT id, valuation_id, type, title, body, read_at, created_at
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
    section(
      pool,
      `SELECT s.to_email, s.reason::text AS reason, s.detail, s.created_at, s.released_at
         FROM email_suppressions s
         JOIN users u ON lower(u.email) = lower(s.to_email)
        WHERE u.id = $1 ORDER BY s.created_at DESC LIMIT $2`,
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
    section(
      pool,
      `SELECT p.id, p.valuation_id, p.provider, p.amount_cents, p.currency, p.status,
              p.refunded_cents, p.refunded_at, p.dispute_status, p.receipt_url, p.created_at
         FROM payments p JOIN valuations v ON v.id = p.valuation_id
        WHERE v.user_id = $1 ORDER BY p.created_at DESC LIMIT $2`,
      [userId],
    ),
    section(
      pool,
      `SELECT id, number, amount_cents, currency, status, period_start, period_end,
              line_items, issued_at, paid_at
         FROM invoices WHERE user_id = $1 ORDER BY issued_at DESC LIMIT $2`,
      [userId],
    ),
    section(
      pool,
      `SELECT id, plan_tier, status, valuations_used, current_period_start, current_period_end,
              canceled_at, created_at
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
    mentions,
    saved_views: savedViews,
    signatures,
    trusted_devices: trustedDevices,
    support_messages: supportMessages,
    payments,
    invoices,
    subscriptions,
    api_tokens: apiTokens,
    section_limit: EXPORT_SECTION_LIMIT,
  };
}
