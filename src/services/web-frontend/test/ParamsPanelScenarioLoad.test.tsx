import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ParamsPanel } from '../src/components/valuation/ParamsPanel';

/**
 * R340, methodology M5 — a failed read of the saved exit scenarios.
 *
 * `ParamsPanel` fetches `/engine-inputs` after `/params` to fill the PWERM
 * scenario table, and the fetch used to be wrapped in a bare `catch {}` whose
 * comment read "engine-inputs is ops-only / may 404 for owners — scenarios stay
 * empty". Only the PATCH is ops-only; the GET guards on `canReadValuation`,
 * which the `/params` read immediately above has already passed. So the swallow
 * caught 5xx, transport failures and expired sessions, and the panel answered
 * all of them with "No scenarios yet" — a claim about the model on the tab
 * where the model is the deliverable, and one `saveScenarios` can make true,
 * because it PATCHes the whole `pwerm.scenarios` array.
 */

const VAL_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

const PARAMS = {
  valuation_id: VAL_ID,
  allocation_method: 'pwerm',
  version: 3,
  updated_at: '2026-07-01T00:00:00Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** `engineInputs` is what the second GET answers with — a Response or a throw. */
function mockApi(engineInputs: () => Response | Promise<Response>) {
  const patched: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === 'PATCH') {
      patched.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return json({ params: PARAMS });
    }
    if (path.includes('/engine-inputs')) return engineInputs();
    return json({ params: PARAMS });
  });
  return patched;
}

async function renderPanel(engineInputs: () => Response | Promise<Response>) {
  const patched = mockApi(engineInputs);
  render(<ParamsPanel valuationId={VAL_ID} readOnly={false} />);
  await screen.findByLabelText('Allocation method');
  return { patched, user: userEvent.setup() };
}

const addButton = () => screen.getByRole('button', { name: /add scenario/i });
const saveScenarios = () => screen.getByRole('button', { name: /save scenarios/i });

describe('ParamsPanel — the saved exit scenarios could not be read', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says so instead of claiming there are none', async () => {
    await renderPanel(() => json({ title: 'Internal Server Error' }, 500));

    const note = await screen.findByTestId('scenario-load-error');
    expect(note).toHaveAttribute('role', 'alert');
    expect(note.textContent).toMatch(/not shown/i);
    expect(screen.queryByText(/no scenarios yet/i)).toBeNull();
  });

  it('refuses to let the empty table be saved over the set it could not read', async () => {
    await renderPanel(() => json({ title: 'Internal Server Error' }, 500));

    await screen.findByTestId('scenario-load-error');
    expect(addButton()).toBeDisabled();
    expect(saveScenarios()).toBeDisabled();
  });

  it('treats a transport failure the same way', async () => {
    await renderPanel(() => Promise.reject(new TypeError('Failed to fetch')));

    expect(await screen.findByTestId('scenario-load-error')).toBeTruthy();
    expect(saveScenarios()).toBeDisabled();
  });

  it('still reads a 404 as the absence it is', async () => {
    // No `valuation_params` row at all: an empty table here is the truth, and
    // the analyst may add the first scenario.
    await renderPanel(() => json({ title: 'Not Found' }, 404));

    expect(await screen.findByText(/no scenarios yet/i)).toBeTruthy();
    expect(screen.queryByTestId('scenario-load-error')).toBeNull();
    expect(addButton()).not.toBeDisabled();
  });

  it('draws the saved scenarios when the read succeeds', async () => {
    const { user } = await renderPanel(() =>
      json({
        engine_inputs: {
          pwerm: {
            scenarios: [
              { name: 'IPO', type: 'ipo', probability: 0.4, equity_value: 50_000_000, time_to_exit_years: 3 },
              {
                name: 'Sale',
                type: 'acquisition',
                probability: 0.6,
                equity_value: 20_000_000,
                time_to_exit_years: 2,
              },
            ],
          },
        },
        version: 3,
      }),
    );

    expect(screen.queryByTestId('scenario-load-error')).toBeNull();
    expect(screen.getAllByDisplayValue('IPO').length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue('Sale').length).toBeGreaterThan(0);

    // And the save still sends both rows — the guard added here does not stand
    // in the way of the ordinary path.
    await user.click(saveScenarios());
    const patch = await vi.waitFor(() => {
      const calls = vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
      expect(calls).toHaveLength(1);
      return calls[0]![1] as RequestInit;
    });
    const body = JSON.parse(String(patch.body)) as { pwerm: { scenarios: unknown[] } };
    expect(body.pwerm.scenarios).toHaveLength(2);
  });
});
