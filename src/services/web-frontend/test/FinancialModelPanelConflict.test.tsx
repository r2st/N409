import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FinancialModelPanel } from '../src/components/valuation/FinancialModelPanel';
import type { EngineInputs } from '../src/lib/pipeline';

/**
 * The panel's half of the lost-update fix (migration 0158).
 *
 * Save posts the *whole* model — income, market and asset together, touched or
 * not — and the server merges top-level blocks wholesale. So this form's copy
 * of a block the analyst never opened is a live overwrite of whatever another
 * analyst put there, and the only thing standing between the two is the
 * `If-Match` this panel sends. Three things have to hold: it sends the version
 * it loaded, it adopts the version each save returns, and it reloads on a 409
 * instead of leaving the stale blocks sitting in the form ready to be posted
 * again.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const conflict = () =>
  jsonResponse(
    {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'These valuation parameters were changed by someone else (expected version 4, now 9).',
    },
    409,
  );

const INPUTS: EngineInputs = { shares_outstanding_common: 8_000_000 };

/** GETs answer with `version`; PATCHes are answered by `patch`, in order. */
function mockApi(versions: number[], patches: Array<() => Response>) {
  let reads = 0;
  let writes = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (!init || init.method === undefined || init.method === 'GET') {
      const version = versions[Math.min(reads, versions.length - 1)];
      reads += 1;
      return jsonResponse({ engine_inputs: INPUTS, version });
    }
    const responder = patches[Math.min(writes, patches.length - 1)]!;
    writes += 1;
    return responder();
  });
}

const patchCalls = (mock: ReturnType<typeof mockApi>) =>
  mock.mock.calls.filter(([, init]) => init?.method === 'PATCH');

/**
 * A read is anything that is not the write. `api()` passes an init object with
 * no `method` for a GET, so testing for `'GET'` counts none of them.
 */
const getCalls = (mock: ReturnType<typeof mockApi>) =>
  mock.mock.calls.filter(([, init]) => init?.method === undefined);

const ifMatchOf = (call: Parameters<typeof fetch>): string | undefined =>
  new Headers(call[1]?.headers).get('if-match') ?? undefined;

async function save() {
  await userEvent.click(screen.getByRole('button', { name: 'Save financial model' }));
}

describe('FinancialModelPanel — concurrent editors', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends the version it loaded as If-Match', async () => {
    const fetchMock = mockApi([4], [() => jsonResponse({ params: { version: 5 } })]);
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);
    await screen.findByLabelText('Year 1 free cash flow');

    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(ifMatchOf(patchCalls(fetchMock)[0] as Parameters<typeof fetch>)).toBe('"4"');
  });

  /**
   * Without this the panel conflicts with itself: the second save would still
   * assert the version the first one consumed, and the analyst would be told
   * somebody else edited the model when the somebody else was them.
   */
  it('adopts the version the save returned, so a second save is not refused', async () => {
    const fetchMock = mockApi(
      [4],
      [() => jsonResponse({ params: { version: 5 } }), () => jsonResponse({ params: { version: 6 } })],
    );
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);
    await screen.findByLabelText('Year 1 free cash flow');

    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(2));

    expect(ifMatchOf(patchCalls(fetchMock)[1] as Parameters<typeof fetch>)).toBe('"5"');
  });

  it('reports a conflict in the words the server used', async () => {
    mockApi([4, 9], [conflict]);
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);
    await screen.findByLabelText('Year 1 free cash flow');

    await save();
    expect(await screen.findByText(/changed by someone else/i)).toBeInTheDocument();
  });

  /**
   * The load-bearing part of the recovery. A 409 that left the form alone would
   * leave the analyst holding the same stale blocks — the next save would post
   * them again, and against the refreshed version it would succeed, which is
   * the original bug with an extra step.
   */
  it('reloads on a conflict and retries against the version that actually landed', async () => {
    const fetchMock = mockApi([4, 9], [conflict, () => jsonResponse({ params: { version: 10 } })]);
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);
    await screen.findByLabelText('Year 1 free cash flow');

    await save();
    await screen.findByText(/changed by someone else/i);
    // The reload happened: a second GET went out.
    await waitFor(() => expect(getCalls(fetchMock)).toHaveLength(2));

    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(2));
    expect(ifMatchOf(patchCalls(fetchMock)[1] as Parameters<typeof fetch>)).toBe('"9"');
  });

  /**
   * An ordinary failure is not a conflict: reloading there would throw away the
   * analyst's unsaved edits to recover from something a retry would fix.
   */
  it('does not reload the form on a non-conflict failure', async () => {
    const fetchMock = mockApi([4], [() => jsonResponse({ detail: 'boom' }, 500)]);
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);
    await screen.findByLabelText('Year 1 free cash flow');

    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(getCalls(fetchMock)).toHaveLength(1);
  });

  /**
   * A server that does not report a version yet must not be sent
   * `If-Match: "undefined"`, which it would refuse as malformed.
   */
  it('sends no If-Match when the load carried no version', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (!init || init.method === undefined || init.method === 'GET') {
        return jsonResponse({ engine_inputs: INPUTS });
      }
      return jsonResponse({ params: {} });
    });
    render(<FinancialModelPanel valuationId="v1" readOnly={false} />);
    await screen.findByLabelText('Year 1 free cash flow');

    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(ifMatchOf(patchCalls(fetchMock)[0] as Parameters<typeof fetch>)).toBeUndefined();
  });
});
