import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Narrative prompt library (migration 0114): the seeded base + per-kind
 * overrides, ops-only editing, reset-to-seed, and the preview that answers
 * "what will a report of this kind actually be drafted with?".
 */

const dbUp = await isDbAvailable();

interface PromptJson {
  id: string;
  kind: string | null;
  section_key: string;
  label: string;
  guidance: string;
  default_guidance: string;
  sort_order: number;
  enabled: boolean;
  updated_by: string | null;
}

interface SectionJson {
  key: string;
  label: string;
  guidance: string;
  overridden: boolean;
}

describe.skipIf(!dbUp)('narrative prompt library', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const listAll = async (token: string) =>
    ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/narrative-prompts',
      headers: authHeader(token),
    });

  const preview = async (kind: string, token = ops.token) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/narrative-prompts/preview/${kind}`,
      headers: authHeader(token),
    });

  const sectionsFor = async (kind: string): Promise<SectionJson[]> =>
    (await preview(kind)).json().sections as SectionJson[];

  /** The seeded row for a (kind, section) pair — the unit every test edits. */
  const findRow = async (kind: string | null, sectionKey: string): Promise<PromptJson> => {
    const prompts = (await listAll(ops.token)).json().prompts as PromptJson[];
    const row = prompts.find((p) => p.kind === kind && p.section_key === sectionKey);
    expect(row, `no seeded row for ${kind ?? 'base'}/${sectionKey}`).toBeDefined();
    return row!;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  it('seeds the eight base sections plus the specialty overrides', async () => {
    const res = await listAll(ops.token);
    expect(res.statusCode).toBe(200);
    const prompts = res.json().prompts as PromptJson[];

    const base = prompts.filter((p) => p.kind === null);
    expect(base).toHaveLength(8);
    expect(base.map((p) => p.section_key)).toEqual([
      'executive_summary',
      'company_overview',
      'valuation_methodology',
      'market_approach',
      'income_approach',
      'allocation_methodology',
      'dlom_analysis',
      'conclusion',
    ]);

    // Every seeded row starts as its own default, so "reset" is a no-op until
    // someone edits it.
    expect(prompts.every((p) => p.guidance === p.default_guidance)).toBe(true);
    expect(new Set(prompts.map((p) => p.kind))).toContain('qsbs');
  });

  it('is operations-only, in both directions', async () => {
    expect((await listAll(client.token)).statusCode).toBe(403);
    expect((await preview('409a', client.token)).statusCode).toBe(403);

    const row = await findRow(null, 'conclusion');
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/narrative-prompts/${row.id}`,
      headers: authHeader(client.token),
      payload: { guidance: 'nope' },
    });
    expect(patch.statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/narrative-prompts' });
    expect(res.statusCode).toBe(401);
  });

  it('drafts a 409A from the base library alone', async () => {
    const sections = await sectionsFor('409a');
    expect(sections.map((s) => s.key)).toEqual([
      'executive_summary',
      'company_overview',
      'valuation_methodology',
      'market_approach',
      'income_approach',
      'allocation_methodology',
      'dlom_analysis',
      'conclusion',
    ]);
    expect(sections.every((s) => !s.overridden)).toBe(true);
  });

  it('drafts QSBS with the statutory tests instead of the 409A sections', async () => {
    const sections = await sectionsFor('qsbs');
    const keys = sections.map((s) => s.key);

    expect(keys).toContain('gross_asset_test');
    expect(keys).toContain('active_business_test');
    // The point of the override: a §1202 memorandum is a qualification
    // attestation, so there is no equity value to allocate, no approach to
    // weight and no marketability discount to take.
    for (const suppressed of [
      'dlom_analysis',
      'allocation_methodology',
      'market_approach',
      'income_approach',
      'valuation_methodology',
    ]) {
      expect(keys).not.toContain(suppressed);
    }
    // `company_overview` used to be asserted here as a section that survives.
    // It does not: the §1202 skeleton has no company chapter, the map routes
    // the section to NULL, and every run drafted a business description that
    // `applyNarrative` then discarded. What the memorandum says about the
    // business it says under the active-business test, which is the chapter an
    // examiner reads it in.
    expect(keys).not.toContain('company_overview');
    expect(keys).toContain('conclusion');

    const summary = sections.find((s) => s.key === 'executive_summary')!;
    expect(summary.overridden).toBe(true);
    expect(summary.guidance).toMatch(/1202/);
  });

  it('gives ASC 820, gift & estate and IFRS 2 their own governing sections', async () => {
    expect((await sectionsFor('820')).map((s) => s.key)).toContain('fair_value_hierarchy');
    expect((await sectionsFor('gifts')).map((s) => s.key)).toContain('revenue_ruling_factors');
    expect((await sectionsFor('ifrs2')).map((s) => s.key)).toContain('vesting_conditions');
  });

  /**
   * The five 0141 converted. Each has chapters the 409A does not, and each was
   * previously previewing the base eight — which is to say the preview screen
   * showed an analyst that an ASC 718 report would be drafted with a
   * marketability discount and a PWERM allocation on it.
   */
  it.each([
    ['718', ['measurement_objective', 'awards', 'expense_recognition']],
    ['fund', ['unit_of_account', 'fair_value_hierarchy', 'lp_economics']],
    ['debt', ['instrument_terms', 'standard_of_value', 'sensitivity']],
    ['goodwill', ['reporting_units', 'qualitative_assessment']],
    ['ip', ['asset_description']],
  ])('previews %s with its own chapters and none of the equity ones', async (kind, expected) => {
    const keys = (await sectionsFor(kind)).map((s) => s.key);
    for (const key of expected) expect(keys, `${kind} is missing ${key}`).toContain(key);
    for (const gone of ['allocation_methodology', 'dlom_analysis', 'market_approach']) {
      expect(keys, `${kind} still drafts ${gone}`).not.toContain(gone);
    }
  });

  /**
   * The six 0145 closed. Same defect as the five above and one step further
   * along: these kinds already had chapters under other names, so the preview
   * showed an analyst that an EMI pack would be drafted with a marketability
   * discount where HMRC expects the UMV/AMV pair, and an ESOP report with no
   * level-of-value argument at all.
   */
  it.each([
    ['csop', ['scheme_limits']],
    ['emi', ['scheme_limits', 'dlom_analysis']],
    ['esop', ['repurchase_obligation', 'dlom_analysis']],
    ['fmv', ['earnings_normalization']],
    ['gifts', ['chapter_14']],
    ['ifrs2', ['awards']],
  ])('previews %s with the chapters only it has', async (kind, expected) => {
    const keys = (await sectionsFor(kind)).map((s) => s.key);
    for (const key of expected) expect(keys, `${kind} is missing ${key}`).toContain(key);
    // Every one of them renames or suppresses the equity allocation, and none
    // of them should still be asking for a 409A's approach chapters.
    for (const gone of ['allocation_methodology', 'market_approach', 'income_approach']) {
      expect(keys, `${kind} still drafts ${gone}`).not.toContain(gone);
    }
  });

  it('gives the renamed chapters this deliverable’s subject', async () => {
    // EMI's is the clearest: the chapter the map sends `dlom_analysis` to is
    // not a discount discussion, it is the statutory pair HMRC agrees.
    const umv = (await sectionsFor('emi')).find((s) => s.key === 'dlom_analysis');
    expect(umv?.label).toBe('UMV and AMV');
    expect(umv?.overridden).toBe(true);
    expect(umv?.guidance).toMatch(/actual market value/);
    expect(umv?.guidance).not.toMatch(/DLOM method chosen/);

    const level = (await sectionsFor('esop')).find((s) => s.key === 'dlom_analysis');
    expect(level?.label).toBe('Level of Value & Discounts');
    expect(level?.guidance).toMatch(/adequate consideration|level of value|409\(h\)/);
  });

  it('stops asking 820, QSBS and PPA for sections their own map discards', async () => {
    // 0114 suppressed two per kind and left the rest enabled, so the agent was
    // drafting a marketability discount for a Level 3 measurement and an
    // approach weighting for a purchase price allocation — both discarded on
    // arrival, and neither visible as a decision anybody made.
    for (const [kind, gone] of [
      ['820', ['dlom_analysis', 'market_approach', 'income_approach', 'allocation_methodology']],
      ['qsbs', ['company_overview']],
      ['ppa', ['valuation_methodology', 'market_approach', 'income_approach']],
    ] as const) {
      const keys = (await sectionsFor(kind)).map((s) => s.key);
      for (const key of gone) expect(keys, `${kind} still drafts ${key}`).not.toContain(key);
    }
    // And the chapters those kinds are actually argued in survive — including
    // the two §1202 chapters that had no library row at all, so nothing was
    // drafted for them and they shipped as the skeleton wrote them.
    expect((await sectionsFor('820')).map((s) => s.key)).toContain('fair_value_hierarchy');
    expect((await sectionsFor('ppa')).map((s) => s.key)).toContain('intangible_assets');
    const qsbs = await sectionsFor('qsbs');
    expect(qsbs.map((s) => s.key)).toContain('gross_asset_test');
    expect(qsbs.map((s) => s.key)).toContain('issuance_and_holding');
    expect(qsbs.find((s) => s.key === 'exclusion_cap')?.guidance).toMatch(/1202\(b\)/);
  });

  it('rewrites the sections a specialty kind redirects rather than dropping them', async () => {
    // Debt keeps both, because its skeleton files them under other headings —
    // the issuer discussion is a credit assessment and the income approach is
    // the discount-rate build-up. Keeping the key but not the 409A's wording is
    // the whole point of the override.
    const debt = await sectionsFor('debt');
    const credit = debt.find((s) => s.key === 'company_overview');
    expect(credit?.label).toBe('Credit Assessment');
    expect(credit?.overridden).toBe(true);
    expect(credit?.guidance).toMatch(/capital structure/);
    expect(credit?.guidance).not.toMatch(/stage and traction/);

    const rate = debt.find((s) => s.key === 'income_approach');
    expect(rate?.label).toBe('Discount Rate');
    expect(rate?.guidance).toMatch(/credit spread/);
  });

  it('a 0141 suppression resets to the base wording like any other', async () => {
    // The reset path is what makes a suppression reversible, and these rows
    // were seeded with the base library's own text so turning one on gives the
    // standard wording rather than a stub.
    const row = await findRow('fund', 'dlom_analysis');
    expect(row.enabled).toBe(false);
    expect(row.default_guidance).toMatch(/DLOM method chosen/);
  });

  it('suppresses the equity-allocation sections on the kinds that have none', async () => {
    // A PPA allocates a purchase price across assets; an IFRS 2 measurement
    // values an award. Neither allocates equity value to common shares.
    expect((await sectionsFor('ppa')).map((s) => s.key)).not.toContain('allocation_methodology');
    expect((await sectionsFor('ifrs2')).map((s) => s.key)).not.toContain('allocation_methodology');
    // A gift & estate valuation does discount for marketability — this is not
    // a blanket rule about specialty kinds.
    expect((await sectionsFor('gifts')).map((s) => s.key)).toContain('dlom_analysis');
  });

  it('a suppressed section can be turned back on and returns the base wording', async () => {
    const row = await findRow('ppa', 'dlom_analysis');
    expect(row.enabled).toBe(false);
    expect((await sectionsFor('ppa')).map((s) => s.key)).not.toContain('dlom_analysis');

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/narrative-prompts/${row.id}`,
      headers: authHeader(ops.token),
      payload: { enabled: true },
    });
    const restored = (await sectionsFor('ppa')).find((s) => s.key === 'dlom_analysis');
    expect(restored?.guidance).toMatch(/DLOM method chosen/);

    // Leave the library as seeded for the tests that follow.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/narrative-prompts/${row.id}`,
      headers: authHeader(ops.token),
      payload: { enabled: false },
    });
  });

  it('404s an unknown kind rather than previewing an empty report', async () => {
    expect((await preview('not-a-kind')).statusCode).toBe(404);
  });

  it('edits a section, and the edit shows up in the preview', async () => {
    const row = await findRow(null, 'market_approach');
    const guidance = 'the guideline companies, and always state LTM versus NTM';

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/narrative-prompts/${row.id}`,
      headers: authHeader(ops.token),
      payload: { guidance },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json().prompt as PromptJson;
    expect(updated.guidance).toBe(guidance);
    expect(updated.updated_by).toBe(ops.id);
    // The seeded text is the record of what shipped and is never overwritten.
    expect(updated.default_guidance).toBe(row.default_guidance);

    const section = (await sectionsFor('409a')).find((s) => s.key === 'market_approach');
    expect(section?.guidance).toBe(guidance);
  });

  it('resets an edited section back to the text it shipped as', async () => {
    const row = await findRow(null, 'income_approach');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/narrative-prompts/${row.id}`,
      headers: authHeader(ops.token),
      payload: { guidance: 'something a reviewer regretted', enabled: false },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/narrative-prompts/${row.id}/reset`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const reset = res.json().prompt as PromptJson;
    expect(reset.guidance).toBe(row.default_guidance);
    expect(reset.enabled).toBe(true);
  });

  it('turning a section off removes it from that kind and no other', async () => {
    const row = await findRow('820', 'unobservable_inputs');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/narrative-prompts/${row.id}`,
      headers: authHeader(ops.token),
      payload: { enabled: false },
    });

    expect((await sectionsFor('820')).map((s) => s.key)).not.toContain('unobservable_inputs');
    // A 409A never had that section; disabling an 820 row must not disturb it.
    expect((await sectionsFor('409a')).map((s) => s.key)).toContain('income_approach');
  });

  it('rejects an unknown field rather than silently ignoring it', async () => {
    const row = await findRow(null, 'conclusion');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/narrative-prompts/${row.id}`,
      headers: authHeader(ops.token),
      // default_guidance is deliberately not patchable — a "reset" that resets
      // to whatever someone last saved is not a reset.
      payload: { default_guidance: 'rewriting history' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('404s an unknown or malformed id', async () => {
    for (const id of ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'not-a-ulid']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/narrative-prompts/${id}`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('writes an admin event for each change', async () => {
    const row = await findRow('gifts', 'dloc');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/narrative-prompts/${row.id}`,
      headers: authHeader(ops.token),
      payload: { sort_order: 66 },
    });
    const { rows } = await ctx.pool.query(
      `SELECT type, subject_label FROM admin_events
        WHERE subject_type = 'narrative_prompt' AND subject_id = $1`,
      [row.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('narrative_prompt_updated');
    expect(rows[0]!.subject_label).toBe('dloc (gifts)');
  });
});
