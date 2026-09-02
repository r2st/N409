import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * `templateEditor.test.ts` covers the editor working; `autoEmailClock.test.ts`
 * covers campaigns firing. Neither covers what either route does when handed
 * something it must refuse, which left `routes/communications.ts` at 56% branch
 * coverage — the second-lowest of any route.
 *
 * These are the routes that decide what gets sent to a client, so the refusals
 * carry real weight: a campaign wired to a template of the wrong channel would
 * put an email body into an SMS, and a template deleted out from under a live
 * campaign would leave the campaign firing at nothing.
 */
describe.skipIf(!dbUp)('communication settings — refusals', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const ULID_ABSENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const auth = () => authHeader(admin.token);
  let seq = 0;
  const uniqueKey = (prefix: string) => `${prefix}_${(seq += 1)}`;

  async function createTemplate(over: Record<string, unknown> = {}) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/communication-templates',
      headers: auth(),
      payload: {
        key: uniqueKey('tpl'),
        channel: 'email',
        subject: 'Hello',
        body: 'Body text',
        ...over,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().template as { id: string; key: string; channel: string };
  }

  async function createCampaign(over: Record<string, unknown> = {}) {
    const tpl = await createTemplate();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/auto-emails',
      headers: auth(),
      payload: {
        name: uniqueKey('camp'),
        channel: 'email',
        trigger_state: 'started',
        template_key: tpl.key,
        ...over,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { campaign: res.json().auto_email as { id: string; name: string }, template: tpl };
  }

  // ── Templates ─────────────────────────────────────────────────────────────
  describe('templates', () => {
    it('400s a list filter naming a category or channel that does not exist', async () => {
      for (const q of ['?category=archived', '?channel=carrier_pigeon', '?category=open&channel=fax']) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/admin/communication-templates${q}`,
          headers: auth(),
        });
        expect(res.statusCode, q).toBe(400);
      }
    });

    it('422s a create whose key is not a slug, and one with no body', async () => {
      const cases: Record<string, unknown>[] = [
        { key: 'Not A Slug', body: 'x' },
        { key: 'ok_key', body: '' },
        { key: '', body: 'x' },
      ];
      for (const payload of cases) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/admin/communication-templates',
          headers: auth(),
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
        expect(res.json().errors).toBeTruthy();
      }
    });

    it('422s an email template with no subject, and allows an SMS one', async () => {
      // The asymmetry is the rule: an email with a blank subject line is a
      // message a client sees as broken, while SMS has no subject at all, so
      // requiring one would make the field a lie.
      const noSubject = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/communication-templates',
        headers: auth(),
        payload: { key: uniqueKey('nosub'), channel: 'email', body: 'Body' },
      });
      expect(noSubject.statusCode).toBe(422);
      expect(noSubject.json().detail).toMatch(/need a subject/i);

      const sms = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/communication-templates',
        headers: auth(),
        payload: { key: uniqueKey('sms'), channel: 'sms', body: 'Body' },
      });
      expect(sms.statusCode).toBe(201);
    });

    it('409s a duplicate key', async () => {
      const tpl = await createTemplate();
      const again = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/communication-templates',
        headers: auth(),
        payload: { key: tpl.key, channel: 'email', subject: 'S', body: 'B' },
      });
      expect(again.statusCode).toBe(409);
    });

    it('404s a patch, delete or preview against a malformed or absent id', async () => {
      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        const patch = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/communication-templates/${id}`,
          headers: auth(),
          payload: { body: 'x' },
        });
        expect(patch.statusCode, `patch ${id}`).toBe(404);

        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/communication-templates/${id}`,
          headers: auth(),
        });
        expect(del.statusCode, `delete ${id}`).toBe(404);

        const preview = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/admin/communication-templates/${id}/preview`,
          headers: auth(),
          payload: {},
        });
        expect(preview.statusCode, `preview ${id}`).toBe(404);
      }
    });

    it('422s an empty patch and one that blanks an email subject', async () => {
      const tpl = await createTemplate();
      const empty = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/communication-templates/${tpl.id}`,
        headers: auth(),
        payload: {},
      });
      expect(empty.statusCode).toBe(422);

      // Same rule as create, applied to the stored channel rather than the
      // patched one — `channel` is not patchable, so `existing` is the
      // authority on what this template is.
      const blanked = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/communication-templates/${tpl.id}`,
        headers: auth(),
        payload: { subject: '' },
      });
      expect(blanked.statusCode).toBe(422);
      expect(blanked.json().detail).toMatch(/need a subject/i);
    });

    it('lets an SMS template patch its subject to empty', async () => {
      const sms = await createTemplate({ channel: 'sms', subject: '' });
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/communication-templates/${sms.id}`,
        headers: auth(),
        payload: { subject: '' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('409s deleting a template a live campaign still points at', async () => {
      // The campaign references the template by key. Deleting it would leave a
      // campaign that fires and renders nothing, which is worse than a refusal
      // an operator has to think about.
      const { template } = await createCampaign();
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/communication-templates/${template.id}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toMatch(/auto email campaign/i);
    });

    it('204s deleting a template nothing references', async () => {
      const tpl = await createTemplate();
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/communication-templates/${tpl.id}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(204);
    });
  });

  // ── Preview ───────────────────────────────────────────────────────────────
  describe('preview', () => {
    it('422s a variable map that is too large, too long, or not a scalar', async () => {
      // The preview renders these into a body, so an unbounded map is an
      // unbounded email. All three axes are bounded and all three are tested.
      const tpl = await createTemplate();
      const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, 'v']));
      const cases: [string, Record<string, unknown>][] = [
        ['too many vars', { vars: tooMany }],
        ['value too long', { vars: { a: 'x'.repeat(4001) } }],
        ['non-scalar value', { vars: { a: { nested: true } } }],
        ['non-finite number', { vars: { a: Number.POSITIVE_INFINITY } }],
        ['subject too long', { subject: 'x'.repeat(501) }],
        ['body too long', { body: 'x'.repeat(20_001) }],
      ];
      for (const [label, payload] of cases) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/admin/communication-templates/${tpl.id}/preview`,
          headers: auth(),
          payload,
        });
        expect(res.statusCode, label).toBe(422);
      }
    });

    it('422s a preview naming a malformed engagement id, and names the field', async () => {
      // This asked for a 404 and had been failing on `main` since R331, which
      // moved every body id field onto `ulidField()` under a census: the id is
      // now refused by the schema, one statement before the lookup the 404 came
      // from. 422 is the right answer and the better one — a malformed id is a
      // fault in the request rather than a claim about what exists, and the
      // problem body names `valuation_id` so the caller can see which field it
      // was. The route's own `isUlid` check behind the schema is unreachable
      // for this input now, and stays as the belt to the schema's braces.
      const tpl = await createTemplate();
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/admin/communication-templates/${tpl.id}/preview`,
        headers: auth(),
        payload: { valuation_id: 'not-a-ulid' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().errors?.[0]?.path).toContain('valuation_id');
    });

    it('renders an engagement with no partner and no measurement date', async () => {
      // Both optional joins take their empty arm: `partner_id` is null so the
      // partner query is skipped entirely, and `valuation_params.engine_inputs`
      // has no `valuation_date` for most of an engagement's life. Neither may
      // throw — the preview is how an operator checks a template *before* those
      // fields are filled in.
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: '409a', company_name: 'Bare Co' },
      });
      expect(created.statusCode).toBe(201);
      const valuationId = created.json().valuation.id as string;

      const tpl = await createTemplate({ body: 'Hi {{company_name}} — {{valuation_date}}' });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/admin/communication-templates/${tpl.id}/preview`,
        headers: auth(),
        payload: { valuation_id: valuationId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().body).toContain('Bare Co');
    });
  });

  // ── Campaigns ─────────────────────────────────────────────────────────────
  describe('auto email campaigns', () => {
    it('422s a campaign body that does not parse', async () => {
      const cases: Record<string, unknown>[] = [
        { name: 'Not A Slug', trigger_state: 'started', template_key: 'x' },
        { name: 'ok', trigger_state: 'not_a_state', template_key: 'x' },
        { name: 'ok', trigger_state: 'started', template_key: 'x', delay_hours: -1 },
        { name: 'ok', trigger_state: 'started', template_key: 'x', max_sends: 99 },
        { name: 'ok', trigger_state: 'started', template_key: 'x', condition: 'when_i_feel_like_it' },
      ];
      for (const payload of cases) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/admin/auto-emails',
          headers: auth(),
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
    });

    it('422s a campaign naming a template that does not exist', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/auto-emails',
        headers: auth(),
        payload: { name: uniqueKey('c'), trigger_state: 'started', template_key: 'no_such_template' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/Unknown template_key/);
    });

    it('422s a campaign whose channel disagrees with its template', async () => {
      // An email body delivered as an SMS is not a degraded send, it is a
      // different message. The route refuses rather than coercing either side.
      const sms = await createTemplate({ channel: 'sms', subject: '' });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/auto-emails',
        headers: auth(),
        payload: {
          name: uniqueKey('c'),
          channel: 'email',
          trigger_state: 'started',
          template_key: sms.key,
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/is a sms template/);
    });

    it('409s a duplicate campaign name', async () => {
      const { campaign, template } = await createCampaign();
      const again = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/auto-emails',
        headers: auth(),
        payload: {
          name: campaign.name,
          channel: 'email',
          trigger_state: 'started',
          template_key: template.key,
        },
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().detail).toMatch(/already exists/i);
    });

    it('404s a patch or delete against a malformed or absent campaign id', async () => {
      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        const patch = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/auto-emails/${id}`,
          headers: auth(),
          payload: { enabled: false },
        });
        expect(patch.statusCode, `patch ${id}`).toBe(404);

        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/auto-emails/${id}`,
          headers: auth(),
        });
        expect(del.statusCode, `delete ${id}`).toBe(404);
      }
    });

    it('422s an empty campaign patch', async () => {
      const { campaign } = await createCampaign();
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/auto-emails/${campaign.id}`,
        headers: auth(),
        payload: {},
      });
      expect(res.statusCode).toBe(422);
    });

    it('re-checks the channel match against the stored side the patch omits', async () => {
      // The patch may change either half of the pair. `template_key ?? existing`
      // and `channel ?? existing` mean a patch that moves only one of them is
      // still validated against the other — otherwise the mismatch the create
      // route refuses could be reached in two legal steps.
      const { campaign } = await createCampaign();
      const sms = await createTemplate({ channel: 'sms', subject: '' });

      const swapTemplateOnly = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/auto-emails/${campaign.id}`,
        headers: auth(),
        payload: { template_key: sms.key },
      });
      expect(swapTemplateOnly.statusCode).toBe(422);
      expect(swapTemplateOnly.json().detail).toMatch(/channel must match/);

      const swapChannelOnly = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/auto-emails/${campaign.id}`,
        headers: auth(),
        payload: { channel: 'sms' },
      });
      expect(swapChannelOnly.statusCode).toBe(422);

      // Moving both together is the one legal transition.
      const both = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/auto-emails/${campaign.id}`,
        headers: auth(),
        payload: { channel: 'sms', template_key: sms.key },
      });
      expect(both.statusCode).toBe(200);
      expect(both.json().auto_email.channel).toBe('sms');
    });

    it('422s a patch naming a template that does not exist', async () => {
      const { campaign } = await createCampaign();
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/auto-emails/${campaign.id}`,
        headers: auth(),
        payload: { template_key: 'no_such_template' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/Unknown template_key/);
    });

    it('204s a delete and then 404s the same id', async () => {
      const { campaign } = await createCampaign();
      const del = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/auto-emails/${campaign.id}`,
        headers: auth(),
      });
      expect(del.statusCode).toBe(204);
      const again = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/auto-emails/${campaign.id}`,
        headers: auth(),
      });
      expect(again.statusCode).toBe(404);
    });
  });

  // ── Authorisation ─────────────────────────────────────────────────────────
  it('is operations-only on every route, including the variable catalog', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/v1/admin/communication-templates'],
      ['GET', '/api/v1/admin/communication-templates/variables'],
      ['POST', '/api/v1/admin/communication-templates'],
      ['PATCH', `/api/v1/admin/communication-templates/${ULID_ABSENT}`],
      ['DELETE', `/api/v1/admin/communication-templates/${ULID_ABSENT}`],
      ['POST', `/api/v1/admin/communication-templates/${ULID_ABSENT}/preview`],
      ['GET', '/api/v1/admin/auto-emails'],
      ['POST', '/api/v1/admin/auto-emails'],
      ['PATCH', `/api/v1/admin/auto-emails/${ULID_ABSENT}`],
      ['DELETE', `/api/v1/admin/auto-emails/${ULID_ABSENT}`],
      ['POST', '/api/v1/admin/auto-emails/run'],
    ];
    for (const [method, url] of routes) {
      const res = await ctx.app.inject({
        method: method as 'GET',
        url,
        headers: authHeader(client.token),
        payload: method === 'GET' ? undefined : {},
      });
      // 403 before any lookup — a client must not learn which ids exist by
      // reading the status code.
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
