import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAiJob } from '../../src/repos/aiJobs.js';
import { latestPromptVersion, listPrompts } from '../../src/repos/aiPrompts.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Prompt registry versioning (P1 #8): every content edit appends a numbered
 * version, revert restores old content as a NEW version, and AI jobs record
 * the version they ran with.
 */

const dbUp = await isDbAvailable();

interface PromptJson {
  id: string;
  pipeline: string;
  label: string;
  system_prompt: string;
  model: string | null;
}

interface VersionJson {
  version: number;
  system_prompt: string;
  model: string | null;
  created_by_email: string | null;
}

describe.skipIf(!dbUp)('prompt versioning', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };
  let client: { id: string; email: string; token: string };
  let prompt: PromptJson;

  const getVersions = async (id: string, token = ops.token) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/prompts/${id}/versions`,
      headers: authHeader(token),
    });

  const patchPrompt = async (id: string, body: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/prompts/${id}`,
      headers: authHeader(ops.token),
      payload: body,
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/prompts',
      headers: authHeader(ops.token),
    });
    prompt = (res.json().prompts as PromptJson[]).find((p) => p.pipeline === 'extract')!;
  });
  afterAll(async () => ctx?.teardown());

  it('backfills version 1 with the seeded content for every prompt', async () => {
    const prompts = await listPrompts(ctx.pool);
    for (const p of prompts) {
      const res = await getVersions(p.id);
      expect(res.statusCode).toBe(200);
      const versions = res.json().versions as VersionJson[];
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ version: 1, system_prompt: p.system_prompt });
    }
  });

  it('is ops-only', async () => {
    const res = await getVersions(prompt.id, client.token);
    expect(res.statusCode).toBe(403);
  });

  it('appends the next version on a content edit, recording the editor', async () => {
    const res = await patchPrompt(prompt.id, {
      system_prompt: 'Extract v2 system prompt.',
      model: 'stub/model-b',
    });
    expect(res.statusCode).toBe(200);

    const versions = (await getVersions(prompt.id)).json().versions as VersionJson[];
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({
      system_prompt: 'Extract v2 system prompt.',
      model: 'stub/model-b',
      created_by_email: ops.email,
    });
  });

  it('does not version label-only edits', async () => {
    const res = await patchPrompt(prompt.id, { label: 'Data extraction (renamed)' });
    expect(res.statusCode).toBe(200);
    const versions = (await getVersions(prompt.id)).json().versions as VersionJson[];
    expect(versions).toHaveLength(2);
  });

  it('reverts by appending the old content as a new version', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/prompts/${prompt.id}/revert`,
      headers: authHeader(ops.token),
      payload: { version: 1 },
    });
    expect(res.statusCode).toBe(200);
    // Live row now carries v1 content again…
    expect(res.json().prompt.system_prompt).toBe(prompt.system_prompt);
    expect(res.json().prompt.model).toBe(prompt.model);

    // …recorded as version 3; history is append-only.
    const versions = (await getVersions(prompt.id)).json().versions as VersionJson[];
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions[0]!.system_prompt).toBe(prompt.system_prompt);
  });

  it('404s on a revert to a version that never existed', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/prompts/${prompt.id}/revert`,
      headers: authHeader(ops.token),
      payload: { version: 99 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('records the prompt version on new AI jobs', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Prompt Provenance Co' },
    });
    expect(created.statusCode).toBe(201);
    const valuationId = created.json().valuation.id as string;

    const version = await latestPromptVersion(ctx.pool, prompt.id);
    expect(version).toBe(3);
    const job = await createAiJob(ctx.pool, {
      valuationId,
      pipeline: 'extract',
      input: {},
      createdBy: ops.id,
      promptVersion: version,
    });
    expect(job.prompt_version).toBe(3);
  });
});
