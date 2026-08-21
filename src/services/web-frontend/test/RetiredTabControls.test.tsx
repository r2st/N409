import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { Valuation } from '../src/lib/types';

/**
 * The workspace tabs, driven twice each: against a live engagement and against
 * a retired one.
 *
 * R90 put the banner on all twenty-five tabs and left the controls under it
 * alive — so a retired engagement still offered "Record decision", "Run health
 * checks", "Save workbook", "Issue grant". The banner said the work had been
 * withdrawn and the page went on inviting the analyst to add to it; the refusal
 * arrived from the server, after the click, as a 409.
 *
 * WHY BOTH DIRECTIONS, every time. Half of this file is the vacuity guard.
 * "The button is disabled when retired" passes just as well against a tab whose
 * button is disabled always — which is a worse bug than the one being fixed,
 * because it is silent. So every case names one control and asserts it is
 * *enabled* on a live engagement and *disabled* on the retired twin, from the
 * same fixture. Only the `archived_at` differs between the two renders.
 *
 * WHY DISABLED RATHER THAN ABSENT. `queryByText(...)` returning null passes
 * when somebody renames the button, and that is the failure mode this codebase
 * has already been bitten by (see the vacuous-checks note in REVISION). A
 * disabled control is a positive assertion about a control that still exists.
 */

const ROLES = { current: ['admin'] as string[] };

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: {
      id: '01N409OPSUSER000000000000A',
      email: 'olive@n409.example',
      first_name: 'Olive',
      last_name: 'Ops',
      verified: true,
      sso_provider: null,
      partner_id: null,
      roles: ROLES.current,
    },
  }),
}));

const ID = '01N409VA000000000000000091';

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/**
 * Routes are matched longest-first, so a fixture may name both `/workbook` and
 * `/workbook/cells` without the shorter one swallowing the longer.
 */
function mockRoutes(routes: Record<string, unknown>) {
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    const hit = keys.find((k) => u.includes(k));
    if (hit) return jsonResponse(routes[hit]);
    return jsonResponse({});
  });
}

const valuation = (archived: boolean): Valuation =>
  ({
    id: ID,
    number: 4310,
    kind: '409a',
    state: 'review',
    company_name: 'Withdrawn Co',
    currency: 'USD',
    user_id: '01N409OWNER00000000000000A',
    partner_id: null,
    waiting_on_client: false,
    archived_at: archived ? '2026-08-01T00:00:00Z' : null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }) as unknown as Valuation;

function renderTab(element: ReactElement, archived: boolean) {
  const v = valuation(archived);
  return render(
    <MemoryRouter initialEntries={['/v/tab']}>
      <Routes>
        {/* `retired` is derived here the way the shell derives it, so a case
            that sets `archived_at` and saw `retired: false` would be testing
            the harness rather than the tab. */}
        <Route
          path="/v"
          element={
            <Outlet
              context={{
                valuation: v,
                counters: null,
                reload: async () => {},
                viewers: [],
                commentTick: 0,
                retired: Boolean(v.archived_at),
              }}
            />
          }
        >
          <Route path="tab" element={element} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

interface Case {
  /** Tab name, used only in the test title. */
  name: string;
  load: () => Promise<ReactElement>;
  routes: Record<string, unknown>;
  /** The control that must close. Found by role + accessible name. */
  control: string | RegExp;
  /** Defaults to `button`; a tab whose only always-live control is a field
      names that role instead. */
  role?: 'button' | 'textbox' | 'combobox';
}

const CASES: Case[] = [
  {
    name: 'Decisions — recording a methodology decision',
    load: async () => {
      const { DecisionsTab } = await import('../src/pages/valuation/DecisionsTab');
      return <DecisionsTab />;
    },
    routes: { '/decisions': { decisions: [], categories: ['dlom', 'other'] } },
    control: 'Record decision',
  },
  {
    name: 'Health — running the pre-finalization checks',
    load: async () => {
      const { HealthTab } = await import('../src/pages/valuation/HealthTab');
      return <HealthTab />;
    },
    routes: {
      '/health-checks': {
        health_checks: [],
        latest_calculation_id: '01N409CALC0000000000000001',
        gate: { satisfied: true, health_check_id: null, severity: 'ok', blocking: false },
      },
    },
    control: 'Run health checks',
  },
  {
    name: 'QA — running the publish-gate review',
    load: async () => {
      const { QaTab } = await import('../src/pages/valuation/QaTab');
      return <QaTab />;
    },
    routes: {
      '/qa': {
        reviews: [],
        latest_calculation_id: '01N409CALC0000000000000001',
        gate: { satisfied: true, review_id: null, status: 'pass' },
      },
    },
    control: 'Run checks',
  },
  {
    name: 'Engagement — advancing the stage',
    load: async () => {
      const { EngagementTab } = await import('../src/pages/valuation/EngagementTab');
      return <EngagementTab />;
    },
    routes: {
      '/engagement': {
        engagement: {
          current_stage: 'analysis',
          assigned_analyst_id: null,
          stage_entered_at: '2026-02-01T00:00:00Z',
        },
        sla: {
          stage: 'analysis',
          label: 'Analysis',
          overdue: false,
          level: 'green',
          expected_hours: 48,
          elapsed_hours: 4,
        },
        stages: [
          { key: 'analysis', label: 'Analysis' },
          { key: 'complete', label: 'Complete', terminal: true },
        ],
        durations: [],
        activity: [],
      },
    },
    control: 'Advance to next stage',
  },
  {
    name: 'Monitoring — enabling the revaluation watch',
    load: async () => {
      const { MonitoringTab } = await import('../src/pages/valuation/MonitoringTab');
      return <MonitoringTab />;
    },
    routes: { '/monitor': { monitor: null, status: 'green', triggers: [], monitorable: true } },
    control: 'Enable monitoring',
  },
  {
    name: 'Specialty — running the specialty engine',
    load: async () => {
      const { SpecialtyTab } = await import('../src/pages/valuation/SpecialtyTab');
      return <SpecialtyTab />;
    },
    routes: {
      '/specialty': {
        kind: 'asc820',
        supported: true,
        engine: {
          kind: 'asc820',
          label: 'ASC 820',
          path: 'asc820',
          produces: 'fair value',
          runInputs: [],
        },
        calculation: null,
        result: null,
        history: [],
      },
    },
    control: /Run ASC 820/,
  },
  {
    name: 'Workbook — saving edited statement cells',
    load: async () => {
      const { WorkbookTab } = await import('../src/pages/valuation/WorkbookTab');
      return <WorkbookTab />;
    },
    routes: {
      '/workbook': {
        sheets: [
          {
            key: 'income',
            label: 'Income statement',
            description: 'Revenue and costs.',
            columns: [{ key: 'fy2025', label: 'FY2025' }],
            rows: [
              {
                key: 'revenue',
                label: 'Revenue',
                kind: 'input',
                format: 'currency',
                cells: [{ column_key: 'fy2025', value: 1000 }],
              },
            ],
          },
        ],
        anomalies: { empty: true, anomalies: [], counts: { error: 0, warning: 0, info: 0 } },
      },
    },
    // Not `Save workbook`: that button is disabled until a cell is dirty, so
    // asserting it is disabled on a retired engagement would pass against a
    // tab that changed nothing. The cell is where the typing happens and the
    // only control here that is unconditionally live.
    control: 'Revenue fy2025',
    role: 'textbox',
  },
  {
    name: 'Overwrites — overriding a computed field',
    load: async () => {
      const { OverwritesTab } = await import('../src/pages/valuation/OverwritesTab');
      return <OverwritesTab />;
    },
    routes: {
      '/overwrites/schema': {
        categories: [{ key: 'discounts', field_count: 1 }],
        fields: [
          {
            key: 'dlom',
            category: 'discounts',
            class: 'numeric',
            label: 'DLOM',
            description: 'Discount for lack of marketability.',
            example: 30,
          },
        ],
        total: 1,
      },
      [`/valuations/${ID}/overwrites`]: { overwrites: [] },
    },
    control: 'Override',
  },
  {
    name: 'Research — refreshing the market research',
    load: async () => {
      const { ResearchTab } = await import('../src/pages/valuation/ResearchTab');
      return <ResearchTab />;
    },
    routes: {
      '/research/topics': {
        topics: [
          {
            topic: 'industry_outlook',
            label: 'Industry outlook',
            description: 'What the sector is doing.',
          },
        ],
        regions: [{ key: 'us', label: 'United States' }],
        stale_days: 90,
      },
      [`/valuations/${ID}/research`]: { research: [], stale_days: 90, can_run: true },
    },
    control: 'Refresh all',
  },
  {
    name: 'Comparables — re-screening the peer set',
    load: async () => {
      const { ComparablesTab } = await import('../src/pages/valuation/ComparablesTab');
      return <ComparablesTab />;
    },
    routes: {
      [`/valuations/${ID}/comparables`]: {
        comparables: [],
        statistics: {},
        primary_multiple: 'ev_revenue_ltm',
        market_method: null,
        market_horizon: null,
        can_edit: true,
      },
      // Mounted below the peer set on the same tab; without a fixture its own
      // load throws inside render and the failure is reported as an unhandled
      // error rather than as this test.
      [`/valuations/${ID}/volatility`]: {
        estimates: [],
        applied_volatility: null,
        eligible_tickers: [],
      },
    },
    control: 'Re-screen',
  },
  {
    name: 'Grants — issuing an option grant',
    load: async () => {
      const { GrantsTab } = await import('../src/pages/valuation/GrantsTab');
      return <GrantsTab />;
    },
    routes: { [`/valuations/${ID}/grants`]: { grants: [] } },
    control: 'New grant',
  },
  {
    name: 'Report — saving a new version of the deliverable',
    load: async () => {
      const { ReportTab } = await import('../src/pages/valuation/ReportTab');
      return <ReportTab />;
    },
    routes: {
      [`/valuations/${ID}/report/versions`]: { versions: [] },
      [`/valuations/${ID}/report`]: {
        report: {
          id: '01N409RP000000000000000001',
          valuation_id: ID,
          template_version: '409a.v12',
          status: 'draft',
          current_version: 1,
          created_at: '2026-02-01T00:00:00Z',
          updated_at: '2026-02-01T00:00:00Z',
        },
        version: {
          version: 1,
          content: {
            title: 'Valuation of Withdrawn Co',
            sections: [{ key: 'intro', heading: 'Introduction', html: '<p>Text.</p>' }],
          },
        },
      },
    },
    // Not `Save (new version)` — that is disabled until the draft is dirty.
    // The title box is live from the moment the tab renders for an ops user.
    control: 'Report title',
    role: 'textbox',
  },
  {
    name: 'Scenarios — the what-if sandbox',
    load: async () => {
      const { ScenariosTab } = await import('../src/pages/valuation/ScenariosTab');
      return <ScenariosTab />;
    },
    routes: {
      [`/valuations/${ID}/scenarios/baseline`]: {
        baseline: { equity_value: 50000000, fmv_per_share: 5 },
        defaults: {
          revenue: 5000000,
          growth_rate: 0.03,
          discount_rate: 0.25,
          multiples: [4.5, 6],
          volatility: 0.6,
        },
        approaches: { asset: false, opm_backsolve: false, income: true, market: true },
        currency: 'USD',
      },
      [`/valuations/${ID}/scenarios`]: { scenarios: [] },
    },
    control: 'Reset to baseline',
  },
  {
    name: 'Company — the profile the report’s company section is written from',
    load: async () => {
      const { CompanyTab } = await import('../src/pages/valuation/CompanyTab');
      return <CompanyTab />;
    },
    routes: { [`/valuations/${ID}/company-profile`]: { profile: null } },
    control: 'Save profile',
  },
  {
    name: 'Intake — the client questionnaire',
    load: async () => {
      const { IntakeTab } = await import('../src/pages/valuation/IntakeTab');
      return <IntakeTab />;
    },
    routes: {
      '/intake/schema': {
        sections: [
          {
            key: 'company',
            title: 'Company',
            description: 'Who you are.',
            fields: [{ key: 'legal_name', label: 'Legal name', type: 'text', required: true }],
          },
        ],
      },
      [`/valuations/${ID}/questionnaire`]: {
        answers: {},
        submitted_at: null,
        completion: {
          percentComplete: 0,
          requiredAnswered: 0,
          requiredTotal: 1,
          sections: [{ key: 'company', title: 'Company', complete: false }],
        },
        missing_documents: [{ kind: 'cap_table', label: 'Cap table' }],
        can_edit: true,
      },
    },
    // The field, not the submit: a client filling a questionnaire in on
    // withdrawn work is the case that sent R90 looking, and the box is where
    // that starts.
    control: 'Legal name *',
    role: 'textbox',
  },
  {
    name: 'Cap table — importing a new one',
    load: async () => {
      const { CapTableTab } = await import('../src/pages/valuation/CapTableTab');
      return <CapTableTab />;
    },
    routes: {
      '/cap-table/formats': { formats: [{ key: 'generic', label: 'Generic', columns: {} }] },
      [`/valuations/${ID}/cap-table`]: { cap_table: null, can_edit: true },
    },
    control: 'Import cap table',
  },
  {
    name: 'ASC 718 — running the expense schedule',
    load: async () => {
      const { Asc718Tab } = await import('../src/pages/valuation/Asc718Tab');
      return <Asc718Tab />;
    },
    routes: { [`/valuations/${ID}/asc718/settings`]: { settings: null } },
    control: 'Run ASC 718',
  },
];

describe('a retired engagement closes the controls on every tab that writes', () => {
  beforeEach(() => {
    ROLES.current = ['admin'];
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const c of CASES) {
    it(`${c.name}: open while the engagement is live`, async () => {
      mockRoutes(c.routes);
      renderTab(await c.load(), false);
      await waitFor(() => expect(screen.getByRole(c.role ?? 'button', { name: c.control })).toBeEnabled());
    });

    it(`${c.name}: closed once it is retired`, async () => {
      mockRoutes(c.routes);
      renderTab(await c.load(), true);
      await waitFor(() => expect(screen.getByRole(c.role ?? 'button', { name: c.control })).toBeDisabled());
    });
  }
});
