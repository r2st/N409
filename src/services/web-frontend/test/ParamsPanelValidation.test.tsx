import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ParamsPanel } from '../src/components/valuation/ParamsPanel';

/**
 * R30 — the methodology form was the largest one still asking the browser to
 * check its numbers. Fifteen boxes carried `min`/`max`/`step` and the form
 * carried no `noValidate`, so what happened on a bad figure was whatever the
 * browser decided: a bubble in one wording on Chrome, another on Safari, in the
 * browser's UI language rather than the page's, and nothing at all for a value
 * pasted past the spinner.
 *
 * Each bound asserted below is the one its control still declares as an
 * attribute. The point of every case is that the page now enforces it, names
 * the box it is about, and does not send the figure.
 */

const VAL_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

const PARAMS = {
  valuation_id: VAL_ID,
  rolling_forward: false,
  inception_date: null,
  fiscal_year_end: null,
  weight_asset: null,
  weight_opm: null,
  weight_income: null,
  weight_market: null,
  dloc: null,
  dloc_method: null,
  control_premium: null,
  dloc_synergy_share: null,
  dloc_statistic: null,
  dlom: null,
  dlom_method: null,
  dlom_methods: null,
  dlom_qualitative: null,
  dlom_statistic: null,
  revenue_status: null,
  development_stage: null,
  exit_timeline: null,
  last_round_date: null,
  last_year_revenue_cents: null,
  ytd_revenue_cents: null,
  runway_months: null,
  market_method: null,
  market_horizon: null,
  asset_method: null,
  allocation_method: 'opm',
  business_overview: null,
  updated_at: '2026-07-01T00:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(params: Record<string, unknown> = {}) {
  const row = { ...PARAMS, ...params };
  const patched: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === 'PATCH') {
      patched.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return jsonResponse({ params: row });
    }
    if (path.includes('/engine-inputs')) return jsonResponse({ engine_inputs: {} });
    return jsonResponse({ params: row });
  });
  return patched;
}

async function renderPanel(params: Record<string, unknown> = {}) {
  const patched = mockApi(params);
  render(<ParamsPanel valuationId={VAL_ID} readOnly={false} />);
  await screen.findByLabelText('Allocation method');
  return { patched, user: userEvent.setup() };
}

const saveButton = () => screen.getByRole('button', { name: /save methodology/i });

interface Patch {
  path: string;
  body: Record<string, unknown>;
}

/** Every params PATCH the form has sent — the assertion is usually "none". */
const paramsPatches = (patched: Patch[]) => patched.filter((p) => p.path.includes('/params'));

/**
 * The message `aria-describedby` points at, which is the one rendered next to
 * the box rather than any other copy of the same words on the page.
 */
function messageFor(label: string) {
  const box = screen.getByLabelText(label);
  expect(box).toHaveAttribute('aria-invalid', 'true');
  return document.getElementById(box.getAttribute('aria-describedby')!);
}

describe('ParamsPanel — field bounds on the methodology form', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('refuses an approach weight above the 1 the box declares', async () => {
    const { patched, user } = await renderPanel();

    await user.type(screen.getByLabelText('Asset approach weight'), '2');
    await user.click(saveButton());

    expect(messageFor('Asset approach weight')).toHaveTextContent('Asset approach weight must be at most 1.');
    expect(paramsPatches(patched)).toHaveLength(0);
  });

  it('refuses a negative approach weight', async () => {
    const { patched, user } = await renderPanel();

    // The slider cannot reach it; a paste into the number box can.
    await user.type(screen.getByLabelText('OPM backsolve weight'), '-1');
    await user.click(saveButton());

    expect(messageFor('OPM backsolve weight')).toHaveTextContent('OPM backsolve weight must be at least 0.');
    expect(paramsPatches(patched)).toHaveLength(0);
  });

  it('refuses a runway beyond the 600 months the box declares', async () => {
    const { patched, user } = await renderPanel();

    await user.type(screen.getByLabelText('Runway (months)'), '700');
    await user.click(saveButton());

    expect(messageFor('Runway (months)')).toHaveTextContent('Runway must be at most 600.');
    expect(paramsPatches(patched)).toHaveLength(0);
  });

  it('refuses a DLOC above one whole', async () => {
    const { patched, user } = await renderPanel();

    await user.type(screen.getByTestId('dloc'), '5');
    await user.click(saveButton());

    expect(messageFor('DLOC (fraction)')).toHaveTextContent('DLOC must be at most 1.');
    expect(paramsPatches(patched)).toHaveLength(0);
  });

  it('refuses a control premium beyond the 10× the box declares', async () => {
    const { patched, user } = await renderPanel();

    await user.selectOptions(screen.getByTestId('dloc-method'), 'control_premium');
    await user.type(await screen.findByTestId('control-premium'), '20');
    await user.click(saveButton());

    expect(messageFor('Control premium (fraction)')).toHaveTextContent('Control premium must be at most 10.');
    expect(paramsPatches(patched)).toHaveLength(0);
  });

  it('refuses a synergy share of a whole premium, which would invert to nothing', async () => {
    const { patched, user } = await renderPanel();

    await user.selectOptions(screen.getByTestId('dloc-method'), 'control_premium');
    await user.type(await screen.findByTestId('control-premium'), '0.25');
    await user.type(screen.getByLabelText('Synergy share (fraction)'), '1');
    await user.click(saveButton());

    expect(messageFor('Synergy share (fraction)')).toHaveTextContent('Synergy share must be at most 0.99.');
    expect(paramsPatches(patched)).toHaveLength(0);
  });

  it('refuses a qualitative DLOM above one whole', async () => {
    const { patched, user } = await renderPanel();

    await user.selectOptions(screen.getByTestId('dlom-method'), 'qualitative');
    await user.type(await screen.findByTestId('dlom-qualitative'), '5');
    await user.click(saveButton());

    expect(messageFor('Qualitative DLOM (fraction)')).toHaveTextContent(
      'Qualitative DLOM must be at most 1.',
    );
    expect(paramsPatches(patched)).toHaveLength(0);
  });

  /**
   * The rules are installed per method, so a figure left behind a field that is
   * no longer on screen cannot block a save with a message nobody can read.
   * Switching the derivation away from the premium keeps the figure — an
   * analyst who switches back should find it — but stops enforcing its bound.
   */
  it('does not block on a stale control premium hidden behind a method switch', async () => {
    const { patched, user } = await renderPanel();

    await user.selectOptions(screen.getByTestId('dloc-method'), 'control_premium');
    await user.type(await screen.findByTestId('control-premium'), '20');
    await user.selectOptions(screen.getByTestId('dloc-method'), '');
    await waitFor(() => expect(screen.queryByTestId('control-premium')).toBeNull());

    await user.click(saveButton());
    await waitFor(() => expect(paramsPatches(patched)).toHaveLength(1));
    expect(paramsPatches(patched)[0]!.body).toMatchObject({ control_premium: 20 });
  });

  it('flags a bad figure on blur, before anything is submitted', async () => {
    await renderPanel();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Runway (months)'), '700');
    await user.tab();

    expect(await screen.findByText('Runway must be at most 600.')).toBeInTheDocument();
  });

  it('says nothing about a box that has not been left yet', async () => {
    const { user } = await renderPanel();

    await user.type(screen.getByLabelText('Runway (months)'), '700');

    expect(screen.queryByText('Runway must be at most 600.')).not.toBeInTheDocument();
  });

  it('clears the message as soon as the figure is corrected', async () => {
    const { user } = await renderPanel();

    await user.type(screen.getByLabelText('Runway (months)'), '700');
    await user.click(saveButton());
    expect(await screen.findByText('Runway must be at most 600.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Runway (months)'));
    await user.type(screen.getByLabelText('Runway (months)'), '24');
    await waitFor(() => expect(screen.queryByText('Runway must be at most 600.')).not.toBeInTheDocument());
  });

  it('still saves a methodology whose every figure is in range', async () => {
    const { patched, user } = await renderPanel();

    await user.type(screen.getByLabelText('Runway (months)'), '24');
    await user.type(screen.getByTestId('dloc'), '0.1');
    await user.click(saveButton());

    await waitFor(() => expect(paramsPatches(patched)).toHaveLength(1));
    expect(paramsPatches(patched)[0]!.body).toMatchObject({ runway_months: 24, dloc: 0.1 });
  });
});

describe('ParamsPanel — revenue is named per box', () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * The pair was checked together and the message rendered only on "Last full
   * year revenue", so a negative year-to-date figure put the complaint under a
   * box that was fine and left the offending one unmarked.
   */
  it('marks the year-to-date box when that is the negative one', async () => {
    const { patched, user } = await renderPanel();

    await user.type(screen.getByTestId('ytd-revenue'), '-500');

    expect(messageFor('Revenue year to date')).toHaveTextContent('Revenue cannot be negative.');
    expect(screen.getByLabelText('Last full year revenue')).not.toHaveAttribute('aria-invalid', 'true');

    await user.click(saveButton());
    expect(paramsPatches(patched)).toHaveLength(0);
  });
});

describe('ParamsPanel — the boxes the methodology form does not save', () => {
  beforeEach(() => vi.restoreAllMocks());

  const addScenario = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'Add scenario' }));
    await user.type(await screen.findByLabelText('Scenario 1 probability'), '1');
  };

  it('names the row and the cell when a scenario figure is out of range', async () => {
    const { user } = await renderPanel({ allocation_method: 'pwerm' });
    await addScenario(user);

    await user.type(screen.getByLabelText('Scenario 1 exit value'), '-5');

    expect(await screen.findByTestId('scenario-issue')).toHaveTextContent(
      'Scenario 1: exit value must be at least 0.',
    );
    expect(screen.getByRole('button', { name: /save scenarios/i })).toBeDisabled();
  });

  it('refuses a probability above one whole', async () => {
    const { user } = await renderPanel({ allocation_method: 'pwerm' });
    await user.click(screen.getByRole('button', { name: 'Add scenario' }));
    await user.type(await screen.findByLabelText('Scenario 1 probability'), '4');

    expect(await screen.findByTestId('scenario-issue')).toHaveTextContent(
      'Scenario 1: probability must be at most 1.',
    );
  });

  /**
   * The hybrid weights ride along in the scenarios request, so they are checked
   * by the button that sends it rather than by the methodology form they sit
   * inside.
   */
  it('refuses a hybrid weight above one, at the box', async () => {
    const { user } = await renderPanel({ allocation_method: 'hybrid' });
    await addScenario(user);

    await user.clear(screen.getByLabelText('Hybrid OPM weight'));
    await user.type(screen.getByLabelText('Hybrid OPM weight'), '3');
    await user.tab();

    expect(messageFor('Hybrid OPM weight')).toHaveTextContent('OPM weight must be at most 1.');
    expect(screen.getByRole('button', { name: /save scenarios/i })).toBeDisabled();
  });

  it('names an emptied hybrid weight as required rather than reading it as zero', async () => {
    const { user } = await renderPanel({ allocation_method: 'hybrid' });
    await addScenario(user);

    await user.clear(screen.getByLabelText('Hybrid PWERM weight'));
    await user.tab();

    expect(messageFor('Hybrid PWERM weight')).toHaveTextContent('PWERM weight is required.');
  });

  it('still saves scenarios and hybrid weights that are in range', async () => {
    const { patched, user } = await renderPanel({ allocation_method: 'hybrid' });
    await addScenario(user);

    await user.type(screen.getByLabelText('Scenario 1 exit value'), '5000000');
    await user.type(screen.getByLabelText('Scenario 1 years'), '3');
    await user.click(screen.getByRole('button', { name: /save scenarios/i }));

    await waitFor(() => expect(patched.filter((p) => p.path.includes('/engine-inputs'))).toHaveLength(1));
    expect(patched.find((p) => p.path.includes('/engine-inputs'))!.body).toMatchObject({
      hybrid: { opm_weight: 0.5, pwerm_weight: 0.5 },
    });
  });

  /**
   * Legs of −0.5 and 1.5 sum to exactly one, so the blend's total was never
   * going to catch them. The bound each box declares is checked first.
   */
  it('refuses a blend leg weighted outside 0–1 even when the legs sum to one', async () => {
    const { patched, user } = await renderPanel();

    await user.click(screen.getByTestId('dlom-form-blend'));
    const weights = await screen.findAllByLabelText('Weight');
    await user.clear(weights[0]!);
    await user.type(weights[0]!, '-0.5');
    await user.clear(weights[1]!);
    await user.type(weights[1]!, '1.5');

    expect(await screen.findByText('Every leg needs a weight between 0 and 1.')).toBeInTheDocument();
    expect(screen.getByText('Weight must be at least 0.')).toBeInTheDocument();
    expect(screen.getByText('Weight must be at most 1.')).toBeInTheDocument();

    await user.click(saveButton());
    expect(paramsPatches(patched)).toHaveLength(0);
  });
});
