import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CommunicationsPage } from '../src/pages/CommunicationsPage';
import type { AutoEmail } from '../src/lib/types';

/**
 * The campaign gate, on both sides of the wire.
 *
 * `AUTO_EMAIL_CONDITIONS` in the valuation service is the authority: it is what
 * the DB CHECK constraint accepts and what `dueCandidates` has SQL for. This
 * screen is the only place a campaign is created, and it built its dropdown
 * from a hand-kept list that had stopped at four while the service grew to ten.
 * The six that fell out — `paid`, `intake_incomplete`, `no_captable`,
 * `no_financials`, `unassigned_reviewer`, `unsigned` — were fully built and
 * unreachable, and a campaign already carrying one rendered a `<Select>` whose
 * value matched no `<option>`: blank on the form, blank in the list.
 *
 * So this reads the service's list rather than restating it. A condition added
 * there and not here fails the first test; one that reaches the type but not
 * `CONDITION_LABELS` fails the build before that.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMUNICATIONS_DOMAIN = path.resolve(here, '../../valuation/src/domain/communications.ts');
const TEMPLATE_VARIABLES_DOMAIN = path.resolve(here, '../../valuation/src/domain/templateVariables.ts');

/** The service's list, read out of its source rather than imported. */
function serviceConditions(): string[] {
  const source = readFileSync(COMMUNICATIONS_DOMAIN, 'utf8');
  const block = /export const AUTO_EMAIL_CONDITIONS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!block) throw new Error(`AUTO_EMAIL_CONDITIONS not found in ${COMMUNICATIONS_DOMAIN}`);
  return [...block[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** The service's `TemplateVarScope` union, read out of its source. */
function serviceScopes(): string[] {
  const source = readFileSync(TEMPLATE_VARIABLES_DOMAIN, 'utf8');
  const block = /export type TemplateVarScope =([\s\S]*?);\n/.exec(source);
  if (!block) throw new Error(`TemplateVarScope not found in ${TEMPLATE_VARIABLES_DOMAIN}`);
  // Only the union members, not the words inside the doc comments between them.
  return [...block[1]!.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]!);
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const campaign = (over: Partial<AutoEmail>): AutoEmail => ({
  id: '01N409AE000000000000000001',
  name: 'chase_captable',
  channel: 'email',
  trigger_state: 'started',
  condition: 'always',
  delay_hours: 72,
  repeat_hours: null,
  max_sends: 1,
  template_key: 'document_reminder',
  enabled: true,
  promotional: false,
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
  ...over,
});

function mockApi(autoEmails: AutoEmail[], variables: unknown[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const p = String(url);
    const method = init?.method ?? 'GET';
    if (p.includes('/communication-templates/variables')) return jsonResponse({ variables });
    if (p.includes('/admin/communication-templates')) return jsonResponse({ templates: [] });
    if (p.includes('/admin/auto-emails')) return jsonResponse({ auto_emails: autoEmails });
    if (method !== 'GET') return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${method} ${p}`);
  });
}

async function openNewCampaign(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Auto emails' }));
  await user.click(await screen.findByRole('button', { name: 'New campaign' }));
  return screen.findByLabelText('Condition');
}

describe('auto-email campaign conditions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a list from the service that is worth comparing against', () => {
    // The scan is a regex over source, so it can pass by finding nothing. Both
    // halves of the comparison below would then be trivially equal.
    const conditions = serviceConditions();
    expect(conditions.length).toBeGreaterThanOrEqual(10);
    expect(conditions).toContain('always');
    expect(conditions).toContain('unsigned');
  });

  it('offers every condition the service accepts, each with a label', async () => {
    const user = userEvent.setup();
    mockApi([campaign({})]);
    render(
      <MemoryRouter>
        <CommunicationsPage />
      </MemoryRouter>,
    );

    const select = await openNewCampaign(user);
    const offered = [...select.querySelectorAll('option')].map((o) => ({
      value: o.value,
      label: o.textContent ?? '',
    }));

    expect(offered.map((o) => o.value).sort()).toEqual([...serviceConditions()].sort());
    // A blank label is the same dead end as a missing option: the operator
    // cannot tell the entries apart.
    for (const o of offered) expect(o.label.trim().length).toBeGreaterThan(0);
  });

  it('selects the condition a campaign already carries when editing it', async () => {
    const user = userEvent.setup();
    // The exact shape that was broken: a live campaign gated on one of the six
    // the dropdown had never offered.
    mockApi([campaign({ condition: 'unsigned' })]);
    render(
      <MemoryRouter>
        <CommunicationsPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Auto emails' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const select = await screen.findByLabelText<HTMLSelectElement>('Condition');
    expect(select.value).toBe('unsigned');
    // selectedIndex -1 is what a value matching no option looks like — the
    // blank field that let a save move a gate nobody had been shown.
    expect(select.selectedIndex).toBeGreaterThanOrEqual(0);
  });

  it('names the gate in the campaign list instead of leaving it blank', async () => {
    mockApi([campaign({ condition: 'no_captable' })]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CommunicationsPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Auto emails' }));
    expect(await screen.findByText('No cap table uploaded')).toBeInTheDocument();
  });

  it('heads a group for every variable scope the service serves', async () => {
    // The other half of the same drift. The palette groups the service's
    // variables under headings this screen keeps, and it kept a list of three
    // while the service grew a fourth — a scope with no heading takes its whole
    // group of variables out of the palette without saying so.
    const scopes = serviceScopes();
    expect(scopes.length).toBeGreaterThanOrEqual(4);
    expect(scopes).toContain('payment');

    mockApi(
      [campaign({})],
      scopes.map((scope, i) => ({
        name: `var_${scope}`,
        scope,
        description: `A ${scope} variable`,
        sample: `sample ${i}`,
      })),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CommunicationsPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'New template' }));
    for (const scope of scopes) {
      expect(await screen.findByRole('button', { name: `var_${scope}` })).toBeInTheDocument();
    }
  });
});
