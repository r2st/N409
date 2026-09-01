import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';
import type { IntakeField, IntakeSection } from '../../src/domain/intake.js';

/**
 * A prospect with no account becoming an engagement a firm can work on.
 *
 * clientIntake.test.ts covers the link and the portal thoroughly, and it stops
 * at conversion: the valuation comes back with the right owner and the right
 * answers, and the test ends there. But conversion is the *middle* of this
 * flow, not the end of it. The question the firm actually has afterwards is
 * whether what came out is a working engagement — one that appears on their
 * list, carries the answers into its own questionnaire, has the params intake
 * could speak for already set, and can take a cap table and a report.
 *
 * The dashboard's getting-started checklist is the same question asked from the
 * other side, and it had no coverage at all. It is derived from what the
 * account contains rather than from a box somebody ticked, which is the only
 * way it can be trusted — and equally the way it silently stops moving if one
 * of its counts stops matching the thing it counts.
 *
 * So: mint, fill, submit, convert, and then work the engagement far enough that
 * four of the eight checklist steps tick, asserting the scoping at every step —
 * a prospect's answers, a firm's pipeline and an account's progress are each
 * things one tenant must not be able to read off another.
 */

const dbUp = await isDbAvailable();

/** An answer that satisfies a field's declared rules — derived, not hardcoded. */
function answerFor(field: IntakeField): unknown {
  switch (field.type) {
    case 'number': {
      const min = field.rules?.min ?? 1;
      const max = field.rules?.max ?? min + 1_000;
      const value = Math.min(Math.max(min === 0 ? 1 : min, 12), max);
      return field.rules?.integer ? Math.round(value) : value;
    }
    case 'date': {
      const floor = field.rules?.minDate ?? '2020-06-15';
      return floor > '2020-06-15' ? floor : '2020-06-15';
    }
    case 'boolean':
      return true;
    case 'select':
      return field.options?.[0] ?? null;
    default:
      return 'Recorded during intake.'.slice(0, field.rules?.maxLength ?? 200);
  }
}

function answersFrom(sections: IntakeSection[]): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const section of sections) {
    for (const field of section.fields) answers[field.key] = answerFor(field);
  }
  return answers;
}

const CAP_TABLE_CSV = [
  'class,shares,price,invested',
  'Common Stock,8000000,0.10,',
  '"Series A Preferred",2000000,1.00,2000000',
  'Option Pool,1000000,,',
].join('\n');

describe.skipIf(!dbUp)('a prospect becoming an engagement', () => {
  let ctx: TestApp;
  let firmId: string;
  let rivalFirmId: string;
  /** The firm's own administrator — mints the link and converts what comes back. */
  let firm: Awaited<ReturnType<typeof seedUser>>;
  let rival: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let unaffiliated: Awaited<ReturnType<typeof seedUser>>;

  let linkId: string;
  let token: string;
  let sections: IntakeSection[];
  let valuationId: string;

  const as = (
    token_: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => ctx.app.inject({ method, url, headers: authHeader(token_), ...(payload ? { payload } : {}) });

  /** The prospect: no account, no header — the token is their whole authority. */
  const asProspect = (url: string, payload: unknown) => ctx.app.inject({ method: 'POST', url, payload });

  const stepsFor = async (token_: string): Promise<string[]> => {
    const res = await as(token_, 'GET', '/api/v1/onboarding/progress');
    expect(res.statusCode).toBe(200);
    return res.json().steps as string[];
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    firmId = await seedPartner(ctx, 'Meridian Valuation Partners');
    rivalFirmId = await seedPartner(ctx, 'Rival Advisory Group');
    firm = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    rival = await seedUser(ctx, { roles: ['partner'], partnerId: rivalFirmId });
    ops = await seedUser(ctx, { roles: ['admin'] });
    unaffiliated = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  // ── 1. The firm sends a form ──────────────────────────────────────────────

  it('starts with an empty checklist, because the account is empty', async () => {
    const res = await as(firm.token, 'GET', '/api/v1/onboarding/progress');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ steps: [], completed: 0, total: 8, all_done: false });
  });

  it('mints a link addressed to a prospect, and hands back the token once', async () => {
    const res = await as(firm.token, 'POST', '/api/v1/firm/intake-links', {
      client_name: 'Halyard Systems, Inc.',
      client_email: 'founder@halyard.example',
      label: 'Q1 409A',
      expires_in_days: 14,
    });
    expect(res.statusCode).toBe(201);
    linkId = res.json().link.id as string;
    token = res.json().token as string;
    expect(token).toBeTruthy();
    expect(res.json().url).toContain(`/intake#token=${token}`);
    // The raw token is returned here and never again — the roster carries the
    // link, not the credential.
    expect(JSON.stringify(res.json().link)).not.toContain(token);
  });

  it('refuses a link to an account that belongs to no firm', async () => {
    const res = await as(unaffiliated.token, 'POST', '/api/v1/firm/intake-links', {});
    expect(res.statusCode).toBe(403);
  });

  it('refuses a link to nobody at all', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/firm/intake-links', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  // ── 2. The prospect fills it in ───────────────────────────────────────────

  it('opens the form for somebody with no account, wearing the firm’s brand', async () => {
    const res = await asProspect('/api/v1/intake/portal', { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    sections = body.sections as IntakeSection[];
    expect(sections.length).toBeGreaterThan(0);
    expect(body.client_name).toBe('Halyard Systems, Inc.');
    expect(body.can_edit).toBe(true);
    expect(body.completion.ready).toBe(false);
    // The prospect learns the firm, never the firm's id or its other clients.
    expect(body.firm).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(firmId);
  });

  it('rejects a token that was never issued', async () => {
    const res = await asProspect('/api/v1/intake/portal', { token: 'not-a-real-token' });
    expect(res.statusCode).toBe(401);
  });

  it('saves what has been answered so far and reports how far that is', async () => {
    const all = answersFrom(sections);
    const firstKey = sections[0]!.fields[0]!.key;
    const partial = { [firstKey]: all[firstKey] };

    const res = await asProspect('/api/v1/intake/portal/answers', { token, answers: partial });
    expect(res.statusCode).toBe(200);
    expect(res.json().answers[firstKey]).toEqual(partial[firstKey]);
    expect(res.json().completion.ready).toBe(false);
  });

  it('will not submit a half-answered questionnaire', async () => {
    const res = await asProspect('/api/v1/intake/portal/submit', { token });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/Complete all required fields/i);
  });

  it('accepts the whole questionnaire and submits it', async () => {
    const saved = await asProspect('/api/v1/intake/portal/answers', {
      token,
      answers: answersFrom(sections),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().completion.ready).toBe(true);
    expect(
      (saved.json().issues as Array<{ severity: string }>).filter((i) => i.severity === 'error'),
    ).toEqual([]);

    const submitted = await asProspect('/api/v1/intake/portal/submit', { token });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().submitted_at).toBeTruthy();
  });

  it('freezes the form once it is in, but still shows the prospect what they sent', async () => {
    const res = await asProspect('/api/v1/intake/portal', { token });
    expect(res.statusCode).toBe(200);
    expect(res.json().can_edit).toBe(false);
    expect(res.json().status).toBe('submitted');

    /*
     * R303: 409, not 401. R222 split "already submitted" out of the dead-link
     * response here and this flow was not updated with it, so it has been red
     * on main since 30 Aug.
     *
     * The status is the substance rather than a detail. 401 says the token is
     * no longer good — which is false, and the assertion three lines above
     * proves it false, since the same token just read the form back. What
     * happened is that the questionnaire is in, and the reader is a client with
     * no account who otherwise concludes their answers are gone.
     */
    const late = await asProspect('/api/v1/intake/portal/answers', {
      token,
      answers: { legal_name: 'Nope' },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().detail).toMatch(/already been submitted/);
    expect(late.json().detail).toMatch(/nothing has been lost/);

    // And the write was refused, not merged: what they sent on Friday stands.
    const reread = await asProspect('/api/v1/intake/portal', { token });
    expect(reread.json().answers.legal_name).not.toBe('Nope');
  });

  // ── 3. The firm reads it, and only the firm ───────────────────────────────

  it('shows the firm what came back', async () => {
    const res = await as(firm.token, 'GET', `/api/v1/firm/intake-links/${linkId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().link.status).toBe('submitted');
    expect(Object.keys(res.json().answers).length).toBeGreaterThan(0);
  });

  it('keeps one firm out of another firm’s pipeline', async () => {
    expect((await as(rival.token, 'GET', `/api/v1/firm/intake-links/${linkId}`)).statusCode).toBe(404);
    const rivalRoster = await as(rival.token, 'GET', '/api/v1/firm/intake-links');
    expect((rivalRoster.json().links as Array<{ id: string }>).map((l) => l.id)).not.toContain(linkId);
  });

  it('refuses a rival firm the conversion, whatever they name in the query', async () => {
    const res = await as(
      rival.token,
      'POST',
      `/api/v1/firm/intake-links/${linkId}/convert?partner_id=${firmId}`,
      {},
    );
    expect(res.statusCode).toBe(403);
  });

  // ── 4. Conversion into a workable engagement ──────────────────────────────

  it('converts the submission into the firm’s engagement', async () => {
    const res = await as(firm.token, 'POST', `/api/v1/firm/intake-links/${linkId}/convert`, {
      kind: '409a',
      currency: 'USD',
    });
    expect(res.statusCode).toBe(201);
    valuationId = res.json().valuation.id as string;

    const valuation = res.json().valuation;
    expect(valuation.partner_id).toBe(firmId);
    // The prospect still has no account — the engagement belongs to the member
    // who converted it, which is the whole premise of a shared intake link.
    expect(valuation.user_id).toBe(firm.id);
    expect(valuation.source).toBe('partner');
    expect(res.json().link.status).toBe('converted');
  });

  it('converts once, however many times it is asked', async () => {
    const again = await as(firm.token, 'POST', `/api/v1/firm/intake-links/${linkId}/convert`, {});
    expect(again.statusCode).toBe(409);
  });

  it('carries the prospect’s answers into the engagement’s own questionnaire', async () => {
    const res = await as(firm.token, 'GET', `/api/v1/valuations/${valuationId}/questionnaire`);
    expect(res.statusCode).toBe(200);
    const answers = res.json().answers as Record<string, unknown>;
    const expected = answersFrom(sections);
    // Not "some answers" — the ones the prospect typed. Retyping them is the
    // work this feature exists to remove, and a partial carry is worse than
    // none: nobody re-checks a form that is already filled in.
    for (const [key, value] of Object.entries(expected)) {
      expect(answers[key]).toEqual(value);
    }
    expect(res.json().completion.ready).toBe(true);
  });

  it('seeds the params the questionnaire already answered', async () => {
    const res = await as(firm.token, 'GET', `/api/v1/valuations/${valuationId}/params`);
    expect(res.statusCode).toBe(200);
    const params = res.json().params as Record<string, unknown>;
    expect(params.business_overview).toBeTruthy();
    expect(params.revenue_status).toBeTruthy();
  });

  it('puts the engagement on the firm’s list and nobody else’s', async () => {
    const mine = await as(firm.token, 'GET', '/api/v1/valuations');
    expect((mine.json().valuations as Array<{ id: string }>).map((v) => v.id)).toContain(valuationId);

    const theirs = await as(rival.token, 'GET', '/api/v1/valuations');
    expect((theirs.json().valuations as Array<{ id: string }>).map((v) => v.id)).not.toContain(valuationId);
    expect((await as(rival.token, 'GET', `/api/v1/valuations/${valuationId}`)).statusCode).toBe(404);
  });

  // ── 5. The checklist, which is the account's own view of all this ─────────

  it('ticks the first step off the checklist', async () => {
    const steps = await stepsFor(firm.token);
    expect(steps).toContain('company');
    expect(steps).not.toContain('cap-table');
  });

  it('ticks the cap table once one is imported', async () => {
    const imported = await as(firm.token, 'PUT', `/api/v1/valuations/${valuationId}/cap-table`, {
      format: 'generic',
      csv: CAP_TABLE_CSV,
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().cap_table.entries.length).toBe(3);

    expect(await stepsFor(firm.token)).toContain('cap-table');
  });

  it('ticks methodology and assumptions once an analyst states them', async () => {
    const params = await as(ops.token, 'PATCH', `/api/v1/valuations/${valuationId}/params`, {
      weight_income: 0.5,
      weight_market: 0.5,
      weight_asset: 0,
      weight_opm: 0,
      dlom: 0.25,
    });
    expect(params.statusCode).toBe(200);

    const steps = await stepsFor(firm.token);
    expect(steps).toEqual(expect.arrayContaining(['methodology', 'assumptions']));
  });

  it('ticks the report once one has been drafted', async () => {
    expect((await as(ops.token, 'GET', `/api/v1/valuations/${valuationId}/report`)).statusCode).toBe(200);
    expect((await as(ops.token, 'POST', `/api/v1/valuations/${valuationId}/report/render`)).statusCode).toBe(
      200,
    );
    expect(await stepsFor(firm.token)).toContain('report');
  });

  it('does not claim the steps that have not happened', async () => {
    const res = await as(firm.token, 'GET', '/api/v1/onboarding/progress');
    const body = res.json();
    // Nothing has been calculated, no document uploaded and no board has
    // signed. A checklist that over-claims is worse than one that under-claims:
    // it tells somebody they are finished when they are not.
    expect(body.steps).not.toContain('run');
    expect(body.steps).not.toContain('financials');
    expect(body.steps).not.toContain('board');
    expect(body.all_done).toBe(false);
    expect(body.completed).toBe((body.steps as string[]).length);
  });

  it('counts each firm’s own progress and nobody else’s', async () => {
    // The rival firm has done none of this. Their checklist saying otherwise
    // would mean the counts are not scoped — the same query that decides what
    // they can read.
    expect(await stepsFor(rival.token)).toEqual([]);
    expect(await stepsFor(unaffiliated.token)).toEqual([]);
  });

  it('refuses the checklist to nobody at all', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/onboarding/progress' });
    expect(res.statusCode).toBe(401);
  });

  // ── 6. A link that dies before it is used ─────────────────────────────────

  describe('a withdrawn link', () => {
    let deadToken: string;
    let deadId: string;

    beforeAll(async () => {
      const res = await as(firm.token, 'POST', '/api/v1/firm/intake-links', {
        client_name: 'Withdrawn Prospect, Inc.',
      });
      deadToken = res.json().token as string;
      deadId = res.json().link.id as string;
    });

    it('stops working for the prospect the moment it is withdrawn', async () => {
      expect((await asProspect('/api/v1/intake/portal', { token: deadToken })).statusCode).toBe(200);

      const revoked = await as(firm.token, 'DELETE', `/api/v1/firm/intake-links/${deadId}`);
      expect(revoked.statusCode).toBe(204);

      expect((await asProspect('/api/v1/intake/portal', { token: deadToken })).statusCode).toBe(401);
      expect(
        (await asProspect('/api/v1/intake/portal/answers', { token: deadToken, answers: {} })).statusCode,
      ).toBe(401);
      expect((await asProspect('/api/v1/intake/portal/submit', { token: deadToken })).statusCode).toBe(401);
    });

    it('cannot be converted into an engagement', async () => {
      const res = await as(firm.token, 'POST', `/api/v1/firm/intake-links/${deadId}/convert`, {});
      expect(res.statusCode).toBe(409);
    });
  });
});
