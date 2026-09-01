import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The subject access request, one level below the table census — for every
 * table, not just `users`.
 *
 * `personalDataCensus.test.ts` asks which *tables* are exported.
 * `usersColumnCensus.test.ts` asks the same question one level down, and only
 * of `users`, because that is the table whose inside is the whole question.
 * But every one of the twenty sections enumerates its columns for the same
 * reason the account query does — a column added later must not be exported by
 * an oversight — and "absent by default" fails safe in exactly one direction.
 * Nothing was watching the other for the other nineteen.
 *
 * Three columns were missing when this file was written, all of them added by
 * the last three cycles of work on the things they belong to:
 *
 *   * `invoices.refunded_cents` / `refunded_at` (migration 0169). The same two
 *     columns exist on `payments` and *are* exported there, so a refund was in
 *     the copy when it came off an engagement fee and absent when it came off a
 *     subscription invoice.
 *   * `subscriptions.cancel_at_period_end` (0187). Whether the plan is set to
 *     end — the state R213 added because a cancelled subscription otherwise
 *     reads `active` with no end in sight.
 *   * `notifications.link` (0188). Part of the message the person was shown.
 *
 * None was a decision; each is a column whose migration author had no reason to
 * think about a file in `repos/`. So the rule is stated here: every column of
 * every exported table is in its section's projection, accounted for by one of
 * the classes below, or carries a written reason.
 *
 * ## Why there are classes at all
 *
 * The straight rule produces eighty-three unaccounted columns, and a registry
 * of eighty-three reasons is the same as no registry — the lesson
 * `personalDataCensus` records about its own `ACTOR_COLUMNS`. Three classes
 * carry most of it, and each is a decision this export has already made and
 * written down somewhere:
 *
 *   * **The predicate.** A section selects its rows by the column that names
 *     the subject (`WHERE user_id = $1`). Exporting that id back would restate
 *     `subject_user_id`, which the export already carries at the top level.
 *     Read out of the section's own WHERE clause rather than listed, so a
 *     section keyed on a different column is covered without an edit.
 *   * **Another person.** `*_by` and `actor_id` name the administrator who
 *     acted, and Art. 15(4) is the limit on answering one person's request with
 *     another's. The export makes this call explicitly for `released_by`,
 *     `handled_by` and `actor_id`; it is the same call every time.
 *   * **A credential.** A token hash or digest: the copy would be the harm.
 *     `users`' two are reported as *held* through the export's `withheld` list
 *     rather than omitted silently; the rest are hashes of a value the subject
 *     already holds (their own API token, their own device cookie).
 *
 * What is left is thirty columns, and thirty reasons is a registry somebody can
 * read.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../migrations');
const EXPORT_SRC = path.resolve(HERE, '../../src/repos/dataExport.ts');

/**
 * The one section this rule is not applied to, and why.
 *
 * `valuations` is not a table about a person; it is the engagement, and the
 * section exports the summary that identifies each one the subject owns —
 * number, company, state, dates, the concluded figure. The other twenty-seven
 * columns are the working paper: which template version rendered it, whether
 * the auto-pipeline is on, which reviewer is assigned, when an administrator
 * last read it. Holding those to "exported or explained" would produce
 * twenty-seven reasons that all say "this is how the engagement is run", which
 * is the registry-of-eighty-three failure in miniature.
 *
 * Declared here rather than silently skipped: an engagement is where the
 * *business* data lives, and if that ever stops being true this line is what
 * has to be edited.
 */
const NOT_ABOUT_A_PERSON = new Set(['valuations']);

/** A hash or digest of something. The copy would be the harm. */
const CREDENTIAL = /(^|_)(token_hash|token_sha256|secret|digest|password)(_|$)/;

/** The administrator who acted, not the person the row is about. */
const ANOTHER_PERSON = /(^|_)(by|actor_id)$/;

/**
 * Columns left out on purpose, each with the reason read out.
 *
 * A reason has to say why the person asking is no worse off without it. "It is
 * internal" is not one of those; "the same fact is in the copy under another
 * name" and "this is the mechanism rather than the record" are.
 */
const UNEXPORTED: Record<string, string> = {
  'valuation_comments.email_meta':
    'The headers of an ingested email. Both writers of this column pass `authorId: null` (the ' +
    'inbox relay and the auditor portal), so no row in this section — which selects on ' +
    '`author_id` — has ever carried one. It reaches the subject as the message itself.',
  'documents.storage_path':
    'Where the bytes sit on the platform’s disk. It describes our filesystem, not the person; the ' +
    'document is identified by its filename, which is exported.',
  'documents.reviewed_at':
    'When an analyst signed the upload off. That is the engagement’s workflow rather than a fact ' +
    'about the uploader, and it goes out with the engagement’s own event trail.',
  'email_outbox.claimed_at':
    'The moment a sender process took the row off the queue. Delivery mechanics; what became of ' +
    'the message is `status` and `delivery_state`, both exported.',
  'email_outbox.next_attempt_at':
    'When the retry ladder will try again. Mechanics of a message still in flight, and meaningless ' +
    'once it has landed.',
  'email_outbox.error':
    'The transport’s own wording for a failure. It is upstream text this platform does not vouch ' +
    'for — the reason `errorBodyDisclosure` exists — and can quote a driver or an SMTP reply. That ' +
    'the message failed is `status`.',
  'email_outbox.request_id':
    'The correlation id the send was logged under (migration 0185). It joins log lines to each ' +
    'other, names nobody, and is useless to the reader of an export.',
  'email_suppressions.outbox_id':
    'The bounced message that put the address on the list. The reason and the date are exported; ' +
    'the id points at a row in `emails_sent`, which is in the same copy.',
  'contact_submissions.handled_at':
    'When somebody here picked the enquiry up. Our handling of it, paired with `handled_by`, which ' +
    'is withheld as another person’s data.',
  'user_invitations.partner_id':
    'The firm the invitation was issued under. Named in the copy already — the engagements section ' +
    'carries the partner an account belongs to — and an internal id here adds nothing.',
  'payments.session_id':
    'The Stripe Checkout session. A processor-side handle for one attempt, not a record of the ' +
    'payment; `id`, `amount_cents`, `status` and `receipt_url` are the record.',
  'payments.checkout_url':
    'A live link to a hosted payment page. Exporting it would put a payable link into a file the ' +
    'subject may forward, which is the one thing an export must not do.',
  'payments.charge_id':
    'The processor’s identifier for the charge. Nothing the subject can act on; the receipt URL is ' +
    'the thing that shows them the charge.',
  'payments.payment_intent_id':
    'The processor’s identifier for the intent behind the charge — the same call as `charge_id`.',
  'payments.dispute_id':
    'The processor’s identifier for the dispute — the same call as `charge_id`. R328 added the ' +
    'column to tell a redelivered dispute event from a second dispute, which is bookkeeping about ' +
    'the webhook rather than a fact about the subject; `dispute_status` and `disputed_at` are the ' +
    'two the export carries.',
  'payments.updated_at':
    'When the row was last touched by a webhook. Bookkeeping; every dated fact the subject would ' +
    'want (`created_at`, `refunded_at`, `disputed_at`) is exported in its own right.',
  'invoices.stripe_invoice_id':
    'The processor’s identifier for the invoice. The platform’s `number` is what the invoice calls ' +
    'itself and what support would ask for.',
  'subscriptions.stripe_customer_id':
    'The processor’s identifier for the payer. It names the subject in a system they have no ' +
    'access to, and their own account id is what identifies them here.',
  'subscriptions.stripe_subscription_id':
    'The processor’s identifier for the subscription — the same call as `stripe_customer_id`.',
  'admin_events.id':
    'The row id of an audit event. The event’s type, source and time are exported; the id is a ' +
    'handle for a table the subject cannot query.',
  'admin_events.subject_label':
    'The subject’s own name or address, denormalised onto the row so an event about a deleted ' +
    'account still reads. It is their own data and it is already in the copy, under `account`.',
};

interface Section {
  table: string;
  selected: Set<string>;
  predicate: Set<string>;
}

/**
 * Every `section(pool, \`SELECT …\`)` in the export, read out of its own SQL.
 *
 * Off the source rather than a list beside it, for the reason the table census
 * gives: a hand-kept copy of the truth is the copy that goes stale.
 */
function sections(): Section[] {
  const src = readFileSync(EXPORT_SRC, 'utf8');
  const out: Section[] = [];
  for (const m of src.matchAll(/section\(\s*\n?\s*pool,\s*\n?\s*`([^`]*)`/g)) {
    const sql = m[1]!;
    const from = /\bFROM\s+([a-z0-9_]+)/i.exec(sql);
    const select = /\bSELECT\b([\s\S]*?)\bFROM\b/i.exec(sql);
    if (!from || !select) continue;
    const where = /\bWHERE\b([\s\S]*)$/i.exec(sql);
    out.push({
      table: from[1]!.toLowerCase(),
      // Every bare identifier in the projection. Deliberately loose: an alias
      // or a cast around a column still names it, and a false *positive* here
      // would have to be a column name appearing as a SQL keyword.
      selected: new Set([...select[1]!.matchAll(/\b([a-z0-9_]+)\b/gi)].map((x) => x[1]!.toLowerCase())),
      predicate: new Set(
        [...(where?.[1] ?? '').matchAll(/\b([a-z0-9_]+)\s*=/gi)].map((x) => x[1]!.toLowerCase()),
      ),
    });
  }
  return out;
}

/**
 * Every column a table has, across CREATE TABLE and every later ALTER.
 *
 * The `ALTER` half reads every `ADD COLUMN` inside one statement rather than
 * one per statement — the trap `usersColumnCensus` records, where 0082 adds two
 * columns and 0057 adds three, and a one-per-statement regex sees only the
 * first.
 */
function columnsOf(table: string): Set<string> {
  const cols = new Set<string>();
  const escaped = table.replace(/[^a-z0-9_]/gi, '');
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const create = new RegExp(
      `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?"?${escaped}"?\\s*\\(([\\s\\S]*?)\\n\\s*\\)\\s*;`,
      'gi',
    );
    let m: RegExpExecArray | null;
    while ((m = create.exec(sql))) {
      for (const line of m[1]!.split('\n')) {
        const col = /^\s*([a-z0-9_]+)\s+[a-z]/i.exec(line);
        if (col && !/^(primary|unique|constraint|check|foreign)$/i.test(col[1]!))
          cols.add(col[1]!.toLowerCase());
      }
    }
    const alter = new RegExp(
      `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:public\\.)?"?${escaped}"?\\s+([\\s\\S]*?);`,
      'gi',
    );
    while ((m = alter.exec(sql))) {
      for (const add of m[1]!.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi))
        cols.add(add[1]!.toLowerCase());
      for (const drop of m[1]!.matchAll(/drop\s+column\s+(?:if\s+exists\s+)?([a-z0-9_]+)/gi))
        cols.delete(drop[1]!.toLowerCase());
    }
  }
  return cols;
}

const found = sections();
const audited = found.filter((s) => !NOT_ABOUT_A_PERSON.has(s.table));

/** `table.column` for everything neither projected nor covered by a class. */
function unaccounted(): string[] {
  const out: string[] = [];
  for (const s of audited) {
    for (const col of columnsOf(s.table)) {
      if (s.selected.has(col) || s.predicate.has(col)) continue;
      if (CREDENTIAL.test(col) || ANOTHER_PERSON.test(col)) continue;
      out.push(`${s.table}.${col}`);
    }
  }
  return out.sort();
}

describe('the personal data export accounts for every column it could carry', () => {
  it('reads the export and the schema at all', () => {
    // Vacuity guard on both scans. Every assertion below passes trivially
    // against a scan that matched nothing, and both are regexes over files
    // written in a style they have to keep matching.
    expect(found.length).toBeGreaterThanOrEqual(20);
    expect(found.map((s) => s.table)).toContain('notifications');
    expect(found.map((s) => s.table)).toContain('admin_events');
    for (const s of audited) expect(columnsOf(s.table).size, s.table).toBeGreaterThan(2);
  });

  it('finds the predicate each section selects its rows by', () => {
    // The predicate class is doing a third of the work, and it is read rather
    // than declared — so a WHERE clause this stops parsing would silently move
    // twenty columns into the unaccounted list, or, worse, a section whose
    // predicate went missing would look accounted for.
    const notifications = audited.find((s) => s.table === 'notifications')!;
    expect([...notifications.predicate]).toContain('user_id');
    const tokens = audited.find((s) => s.table === 'api_tokens')!;
    expect([...tokens.predicate]).toContain('created_by');
  });

  it('exports or explains every column of every section', () => {
    // A new column on one of these tables is a decision about a subject access
    // request. Add it to the section's SELECT in `repos/dataExport.ts`, or to
    // UNEXPORTED above with a reason somebody could read out to the person
    // asking.
    expect(unaccounted().filter((c) => !(c in UNEXPORTED))).toEqual([]);
  });

  it('exports the three columns this census was written for', () => {
    // Stated in their own right rather than left to the rule above: each was
    // absent from the copy, and an edit that dropped one again would otherwise
    // fail only as an anonymous entry in a list.
    const byTable = new Map(audited.map((s) => [s.table, s.selected]));
    expect(byTable.get('invoices')).toContain('refunded_cents');
    expect(byTable.get('subscriptions')).toContain('cancel_at_period_end');
    expect(byTable.get('notifications')).toContain('link');
  });

  it('keeps no reason for a column that is exported anyway', () => {
    // A stale entry reads as a considered decision to hold something back that
    // is in fact in the copy — the registry lying in the direction that makes
    // it worthless.
    const live = new Set(unaccounted());
    expect(
      Object.keys(UNEXPORTED)
        .filter((c) => !live.has(c))
        .sort(),
    ).toEqual([]);
  });

  it('gives every omission a reason somebody could read out', () => {
    const thin = Object.entries(UNEXPORTED).filter(([, why]) => why.trim().length < 60);
    expect(thin.map(([c]) => c)).toEqual([]);
  });
});
