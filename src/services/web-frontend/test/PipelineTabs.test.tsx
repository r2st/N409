import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import type { Valuation } from '../src/lib/types';

/**
 * The six workspace tabs that are pure wiring.
 *
 * `PipelineTabs.tsx` holds no logic of its own — it reads the workspace
 * context and the signed-in user and hands both to a panel. That is exactly
 * why it was at 0%: nothing looks worth asserting, and the file is a wiring
 * harness that has to be *right*, because every prop it passes is either an
 * identifier the panel loads from or the flag that decides whether a
 * non-operations reader can edit an engagement.
 *
 * A wrong `valuationId` shows the analyst someone else's documents. A
 * `readOnly` that comes out `false` for a client user hands them the params
 * form. Neither is visible from the panels' own tests, which are handed the
 * props directly.
 *
 * So the panels are stubbed down to their props: the subject here is the
 * adapter, not what it mounts.
 */

const mockUser: { id: string; roles: string[] } | null = { id: 'u1', roles: ['admin'] };

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: mockUser }) }));

/** Every panel becomes a div that prints exactly the props it was given. */
const stub = (name: string) => ({
  [name]: (props: Record<string, unknown>) => (
    <div
      data-testid={name}
      data-props={JSON.stringify(props, (_k, v) => (typeof v === 'function' ? 'fn' : v))}
    />
  ),
});

vi.mock('../src/components/valuation/DocumentsPanel', () => stub('DocumentsPanel'));
vi.mock('../src/components/valuation/AccountingConnect', () => stub('AccountingConnect'));
vi.mock('../src/components/valuation/ParamsPanel', () => stub('ParamsPanel'));
vi.mock('../src/components/valuation/WaccPanel', () => stub('WaccPanel'));
vi.mock('../src/components/valuation/FinancialModelPanel', () => stub('FinancialModelPanel'));
vi.mock('../src/components/valuation/ProjectionPanel', () => stub('ProjectionPanel'));
vi.mock('../src/components/valuation/AiPanel', () => stub('AiPanel'));
vi.mock('../src/components/valuation/TasksPanel', () => stub('TasksPanel'));
vi.mock('../src/components/valuation/CalculationPanel', () => stub('CalculationPanel'));

const { AiTab, CalculationsTab, DocumentsTab, FinancialModelTab, ParamsTab, TasksTab } =
  await import('../src/pages/valuation/PipelineTabs');

const VALUATION_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

const valuation = (over: Partial<Valuation> = {}) =>
  ({
    id: VALUATION_ID,
    kind: '409a',
    state: 'drafted',
    company_name: 'Acme',
    currency: 'USD',
    ...over,
  }) as unknown as Valuation;

const reload = vi.fn();

function renderTab(element: React.ReactNode, v: Valuation = valuation()) {
  return render(
    <MemoryRouter initialEntries={['/v/tab']}>
      <Routes>
        <Route path="/v" element={<Outlet context={{ valuation: v, reload }} />}>
          <Route path="tab" element={element} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const propsOf = (name: string) =>
  JSON.parse(screen.getByTestId(name).dataset.props!) as Record<string, unknown>;

beforeEach(() => {
  mockUser!.roles = ['admin'];
  reload.mockClear();
});

describe('PipelineTabs — every panel gets this engagement', () => {
  it.each([
    ['DocumentsTab', <DocumentsTab key="d" />, ['DocumentsPanel', 'AccountingConnect']],
    ['ParamsTab', <ParamsTab key="p" />, ['ParamsPanel', 'WaccPanel']],
    ['FinancialModelTab', <FinancialModelTab key="f" />, ['FinancialModelPanel', 'ProjectionPanel']],
    ['AiTab', <AiTab key="a" />, ['AiPanel']],
    ['TasksTab', <TasksTab key="t" />, ['TasksPanel']],
    ['CalculationsTab', <CalculationsTab key="c" />, ['CalculationPanel']],
  ])('%s passes the workspace valuation id to each panel it mounts', (_name, element, panels) => {
    renderTab(element);
    for (const panel of panels) {
      expect(propsOf(panel).valuationId, panel).toBe(VALUATION_ID);
    }
  });
});

describe('PipelineTabs — who may edit', () => {
  it('leaves the params and model forms writable for operations', () => {
    renderTab(<ParamsTab />);
    expect(propsOf('ParamsPanel').readOnly).toBe(false);
    expect(propsOf('WaccPanel').readOnly).toBe(false);
  });

  it('makes them read-only for a non-operations reader', () => {
    mockUser!.roles = ['valuation_user'];
    renderTab(<ParamsTab />);
    expect(propsOf('ParamsPanel').readOnly).toBe(true);
    expect(propsOf('WaccPanel').readOnly).toBe(true);
  });

  it('applies the same rule to the financial model and its projections', () => {
    mockUser!.roles = ['valuation_user'];
    renderTab(<FinancialModelTab />);
    expect(propsOf('FinancialModelPanel').readOnly).toBe(true);
    expect(propsOf('ProjectionPanel').readOnly).toBe(true);
  });

  it('gates the document review action on operations, not merely the view', () => {
    renderTab(<DocumentsTab />);
    expect(propsOf('DocumentsPanel').canReview).toBe(true);

    mockUser!.roles = ['client'];
    renderTab(<DocumentsTab />);
    // The last render is the one queried; both are mounted, so read the newest.
    expect(
      screen.getAllByTestId('DocumentsPanel').map((el) => JSON.parse(el.dataset.props!).canReview),
    ).toEqual([true, false]);
  });
});

describe('PipelineTabs — the details that are easy to drop', () => {
  it('reloads the workspace after a document review, so the header chip agrees', () => {
    renderTab(<DocumentsTab />);
    // The callback is what keeps the pending-files chip in the header from
    // disagreeing with the list underneath it.
    expect(propsOf('DocumentsPanel').onReviewed).toBe('fn');
  });

  it("passes the engagement's currency to the panels that format money", () => {
    renderTab(<FinancialModelTab />, valuation({ currency: 'GBP' } as Partial<Valuation>));
    expect(propsOf('ProjectionPanel').currency).toBe('GBP');

    renderTab(<CalculationsTab />, valuation({ currency: 'EUR' } as Partial<Valuation>));
    expect(propsOf('CalculationPanel').currency).toBe('EUR');
  });

  it('falls back to USD rather than undefined when the engagement has no currency', () => {
    renderTab(<FinancialModelTab />, valuation({ currency: null } as unknown as Partial<Valuation>));
    expect(propsOf('ProjectionPanel').currency).toBe('USD');

    renderTab(<CalculationsTab />, valuation({ currency: null } as unknown as Partial<Valuation>));
    expect(propsOf('CalculationPanel').currency).toBe('USD');
  });
});
