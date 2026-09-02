import { describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Every surface that hangs off a partner, and what a firm's archive does to it.
 *
 * `partners.archived_at` is this platform's soft delete for a firm. The rule it
 * states is written down in three places and enforced in none of them
 * centrally: `LIVE_LINK_SQL` in repos/clientIntake.ts ("an archived partner
 * takes no new user assignments, cannot have its branding edited, and is gone
 * from the branding list"), `assertAssignablePartner` in routes/adminUsers.ts
 * ("new partner assignments must reference a live (non-archived) partner"), and
 * `convertIntakeLink` ("a withdrawn firm acquiring fresh work is the thing
 * being prevented").
 *
 * R342 closed four doors and left a gap in its own words: "there is no census
 * of what a partner archive is supposed to stop the way `retiredEngagementWrites`
 * enumerates the valuation soft delete, so the next surface added under a
 * `partner_id` starts outside the rule again." Two more doors were then found
 * in R348 — the invitation that mints a seat a week after the check that
 * allowed it, and the create route that files fresh work under a withdrawn
 * firm — which is exactly the failure the gap predicted.
 *
 * So the question is asked of the live schema rather than of the source. Every
 * foreign key into `partners` is a surface somebody has to have decided about,
 * and a new one fails this until they do. A source scan for `archived_at IS
 * NULL` would pass by finding the clauses that already exist; this fails on a
 * *relationship* nobody has classified, which is the event worth catching.
 *
 * Three verdicts, and every reference must carry exactly one:
 *
 *   refuses    — the archive stops something here, and the refusal is named.
 *   unaffected — the archive deliberately changes nothing, and why.
 *
 * A door that is only partly closed says so in its own entry rather than
 * getting a third verdict: `partner_webhooks` refuses the fan-out and does not
 * stop a delivery already queued, and that half is R342's own recorded gap.
 */

type Verdict = 'refuses' | 'unaffected';

const DOORS: Record<string, { verdict: Verdict; why: string }> = {
  'users.partner_id': {
    verdict: 'refuses',
    why: 'assertAssignablePartner (routes/adminUsers.ts) — an archived firm takes no new member, on create or on patch',
  },
  'user_invitations.partner_id': {
    verdict: 'refuses',
    why: 'LIVE_PARTNER_SQL (repos/invitations.ts, R348) — the invitation is minted under the check and redeemed up to seven days later, so both readers ask again',
  },
  'valuations.partner_id': {
    verdict: 'refuses',
    why: 'POST /valuations (R348) — a withdrawn firm acquires no fresh work, whether ops names the field or a member of the firm creates for themselves',
  },
  'api_tokens.partner_id': {
    verdict: 'refuses',
    why: "resolveApiToken's `partner_retired` refusal (R342) — refused rather than revoked, because archiving is a boolean an administrator can set back",
  },
  'client_intake_links.partner_id': {
    verdict: 'refuses',
    why: 'LIVE_LINK_SQL (repos/clientIntake.ts) — the public form stops opening, saving and submitting, and conversion answers not_found',
  },
  'partner_webhooks.partner_id': {
    verdict: 'refuses',
    why:
      'enabledWebhooks (repos/partnerWebhooks.ts, R342) — the fan-out stops, so no further client ' +
      'transition is disclosed to the withdrawn firm. Only the fan-out: `partner_webhook_deliveries` ' +
      'reaches the firm through this row and a delivery already queued still walks its retry ladder, ' +
      'which R342 recorded as a standing gap — the disclosure was made when the row was written, and ' +
      'a claim query taught to skip these would leave `pending` rows nothing ever settles.',
  },
  'partner_api_idempotency.partner_id': {
    verdict: 'unaffected',
    why: 'a replay cache keyed to requests the API already answered; the key that would reach it is refused a layer above, so nothing new is written and the stored answers are history',
  },
};

describe.skipIf(!dbUp)('partner archive doors', () => {
  it('classifies every foreign key into partners', async () => {
    const db = await setupTestDb();
    try {
      const { rows } = await db.pool.query<{ table_name: string; column_name: string }>(
        `SELECT tc.table_name, kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
            AND ccu.table_name = 'partners'
          ORDER BY tc.table_name, kcu.column_name`,
      );
      const found = rows.map((r) => `${r.table_name}.${r.column_name}`);

      // The catalogue query has to keep matching, or this file is a check that
      // passes by asking nothing — the failure a schema-driven census exists to
      // be immune to.
      expect(found.length).toBeGreaterThanOrEqual(6);

      const unclassified = found.filter((c) => !(c in DOORS));
      expect(
        unclassified,
        'A new table hangs off `partners`. Decide what a firm being archived does to it — the rule is ' +
          '"a withdrawn firm takes no new work and no new people" — and add it to DOORS in this file ' +
          'with the refusal that enforces it, or as `unaffected` with the reason.',
      ).toEqual([]);

      const stale = Object.keys(DOORS).filter((c) => !found.includes(c));
      expect(stale, 'DOORS names a relationship that no longer exists in the schema').toEqual([]);
    } finally {
      await db.teardown();
    }
  }, 120_000);

  it('holds every refusal to a test that actually exercises it', () => {
    /*
     * Not a source scan — a list of the suites that drive an archived firm at
     * each door and watch it be refused. A door classified `refuses` with
     * nothing here is a claim about enforcement nobody is checking, which is
     * the same failure as the missing clause one layer down.
     */
    const refuses = Object.entries(DOORS)
      .filter(([, v]) => v.verdict === 'refuses')
      .map(([c]) => c)
      .sort();
    const covered = [
      // partners.test.ts — the admin console's assign / patch refusals.
      'users.partner_id',
      // inviteArchivedPartner.test.ts — mint, redeem, and the round trip back.
      'user_invitations.partner_id',
      // valuationCreateIds.test.ts — the ops field and the member path.
      'valuations.partner_id',
      // partnerApiRetired.test.ts — `partner_retired` across the surface.
      'api_tokens.partner_id',
      // clientIntakeArchivedFirm.test.ts — open, save, submit, convert.
      'client_intake_links.partner_id',
      // partnerRetirementFanout.test.ts — the four fan-out call sites.
      'partner_webhooks.partner_id',
    ].sort();
    expect(refuses).toEqual(covered);
  });
});
