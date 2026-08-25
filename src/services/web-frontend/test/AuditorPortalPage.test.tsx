import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuditorPortalPage } from '../src/pages/AuditorPortalPage';

/**
 * The auditor portal renders stored report HTML with dangerouslySetInnerHTML.
 * Its reader is an external auditor holding a link token — the one viewer with
 * no account here, and the least reason to trust what we hand them. Server-side
 * sanitisation on save is the primary control, but this page renders whatever
 * is *already stored*, including content written before a sanitiser covered the
 * path that wrote it, so it sanitises again on the way out.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function bundleWithSections(sections: Array<{ heading: string; html: string }>) {
  return {
    valuation: {
      number: '1042',
      company_name: 'Acme Robotics, Inc.',
      kind: '409a',
      state: 'delivered',
      currency: 'USD',
    },
    report: { template_version: 'v54', status: 'final', content: { title: 'Report', sections } },
    assumptions: null,
    conclusion: null,
    qa: [],
    evidence_summary: { has_report: true, has_conclusion: false, qa_count: 0, assumptions_recorded: false },
    access_expires_at: '2030-01-01T00:00:00Z',
  };
}

function mount(sections: Array<{ heading: string; html: string }>) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(bundleWithSections(sections)));
  window.location.hash = '#token=abc123';
  return render(<AuditorPortalPage />);
}

describe('AuditorPortalPage report rendering', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    window.location.hash = '';
  });

  it('strips a script a stored section carries', async () => {
    const { container } = mount([
      { heading: 'Introduction', html: '<p>Prepared for <script>alert(1)</script>Acme.</p>' },
    ]);
    await waitFor(() => expect(screen.getByText('Introduction')).toBeInTheDocument());
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('alert(1)');
  });

  it('drops an event-handler attribute smuggled through a company name', async () => {
    // The exact shape a free-text company_name produced before the report
    // template sanitised the vars it merged in.
    const { container } = mount([
      {
        heading: 'Certification',
        html: '<p>We have no interest in <strong><img src=x onerror="alert(1)">Acme</strong>.</p>',
      },
    ]);
    await waitFor(() => expect(screen.getByText('Certification')).toBeInTheDocument());
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
    // The legible remainder of the section still reaches the auditor.
    expect(container.textContent).toContain('Acme');
  });

  it('keeps the formatting a legitimate report relies on', async () => {
    const { container } = mount([
      {
        heading: 'Methodology',
        html: '<p>We applied the <strong>OPM</strong>.</p><ul><li>Backsolve</li></ul>',
      },
    ]);
    await waitFor(() => expect(screen.getByText('Methodology')).toBeInTheDocument());
    expect(container.querySelector('strong')?.textContent).toBe('OPM');
    expect(container.querySelector('li')?.textContent).toBe('Backsolve');
  });
});

/**
 * The token arrives in the link's fragment, never a query string: a fragment
 * is not sent to the server in the Referer header and does not reach access
 * logs or analytics. Everything below is what an auditor sees once it is
 * exchanged — and what they see when it cannot be.
 */
describe('AuditorPortalPage access', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    window.location.hash = '';
  });

  it('spins while the bundle is being fetched', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    window.location.hash = '#token=abc123';
    render(<AuditorPortalPage />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('exchanges the fragment token by POST, never in the URL', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(bundleWithSections([])));
    window.location.hash = '#token=abc123';
    render(<AuditorPortalPage />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('/api/v1/auditor/portal');
    expect(String(url)).not.toContain('abc123');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ token: 'abc123' });
  });

  it('says so when the link carries no token, without calling the server', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    window.location.hash = '';
    render(<AuditorPortalPage />);

    expect(await screen.findByText('This auditor link is missing its access token.')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces the server’s reason for refusing a token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ title: 'Gone', detail: 'This auditor link has expired.' }, 410),
    );
    window.location.hash = '#token=stale';
    render(<AuditorPortalPage />);
    expect(await screen.findByText('This auditor link has expired.')).toBeInTheDocument();
  });

  it('falls back to a plain refusal when the server gives no reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 403 }));
    window.location.hash = '#token=stale';
    render(<AuditorPortalPage />);
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
  });

  it('falls back again when the request never reaches the server', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue('not an Error');
    window.location.hash = '#token=abc123';
    render(<AuditorPortalPage />);
    expect(await screen.findByText('This link is invalid or expired.')).toBeInTheDocument();
  });
});

describe('AuditorPortalPage bundle', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    window.location.hash = '';
  });

  function mountBundle(over: Record<string, unknown>) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ...bundleWithSections([]), ...over }));
    window.location.hash = '#token=abc123';
    return render(<AuditorPortalPage />);
  }

  it('identifies the engagement and when the access lapses', async () => {
    mountBundle({});
    expect(await screen.findByText('Acme Robotics, Inc.')).toBeInTheDocument();
    expect(screen.getByText('1042 · 409A · delivered')).toBeInTheDocument();
    expect(screen.getByText(/Access expires/)).toBeInTheDocument();
  });

  /*
   * The conclusion is the figure the whole review is about. Both money fields
   * are strings on the wire and are rendered as money; the engine version
   * beside them is not, and formatting it as currency would be nonsense.
   */
  it('renders the concluded figures as money and the engine version as itself', async () => {
    mountBundle({
      conclusion: {
        equity_value: '48250000',
        fmv_per_share: '3.47',
        engine_version: 'engine/v1.4.2',
      },
    });
    expect(await screen.findByText('$3.47')).toBeInTheDocument();
    expect(screen.getByText('$48,250,000.00')).toBeInTheDocument();
    expect(screen.getByText('engine/v1.4.2')).toBeInTheDocument();
  });

  it('leaves an unstruck conclusion as a dash rather than a zero', async () => {
    mountBundle({
      conclusion: { equity_value: null, fmv_per_share: null, engine_version: 'engine/v1.4.2' },
    });
    await screen.findByText('engine/v1.4.2');
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  /*
   * The two figures are captioned by the server, because what they hold depends
   * on the valuation kind: a specialty engine writes its headline into the
   * 409A-named calculation columns (domain/specialty.ts). This page had the
   * captions hardcoded, so an IFRS 2 total share-based-payment expense was
   * labelled "Equity value" for the one reader with no other context.
   */
  it('captions the figures with what the server says they are', async () => {
    mountBundle({
      valuation: {
        number: '2051',
        company_name: 'Awards Ltd',
        kind: 'ifrs2',
        state: 'delivered',
        currency: 'USD',
      },
      conclusion: {
        equity_value: '480000',
        fmv_per_share: null,
        engine_version: 'engine/v1.4.2',
        equity_label: 'Total expense',
        fmv_per_share_label: null,
      },
    });
    expect(await screen.findByText('Total expense')).toBeInTheDocument();
    expect(screen.getByText('$480,000.00')).toBeInTheDocument();
    expect(screen.queryByText('Equity value')).not.toBeInTheDocument();
    // A null caption is the kind having no such figure. Rendering it as an
    // em-dash under a caption that promises a per-share number reads as a
    // calculation that failed rather than one nobody asked for.
    expect(screen.queryByText('Concluded FMV / share')).not.toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('falls back to the 409A wording for a bundle served without captions', async () => {
    // A page loaded against an older build carries neither key; `undefined` is
    // that, and `null` is the kind having no such figure. Only the first falls
    // back, and the two must not be conflated.
    mountBundle({
      conclusion: { equity_value: '48250000', fmv_per_share: '3.47', engine_version: 'engine/v1.4.2' },
    });
    expect(await screen.findByText('Concluded FMV / share')).toBeInTheDocument();
    expect(screen.getByText('Equity value')).toBeInTheDocument();
  });

  it('omits the conclusion block entirely when nothing has been concluded', async () => {
    mountBundle({ conclusion: null });
    await screen.findByText('Acme Robotics, Inc.');
    expect(screen.queryByText('Concluded FMV / share')).not.toBeInTheDocument();
  });

  /** Rates are stored as fractions; an auditor reads percentages. */
  it('states the discounts and weights as percentages, and the absent ones as dashes', async () => {
    mountBundle({
      assumptions: {
        allocation_method: 'opm',
        weights: { asset: '0.1', opm: '0.65', income: '0.25', market: null },
        dloc: '0.05',
        dlom: '0.235',
        dlom_method: 'finnerty',
        exit_timeline: '3.0',
      },
    });
    expect(await screen.findByText('23.5%')).toBeInTheDocument();
    expect(screen.getByText('5.0%')).toBeInTheDocument();
    expect(screen.getByText('65.0%')).toBeInTheDocument();
    expect(screen.getByText('finnerty')).toBeInTheDocument();
    // The unused market weight, and nothing pretending it was zero.
    expect(screen.getAllByText('—')).toHaveLength(1);
  });

  it('names a missing DLOM method rather than leaving the row blank', async () => {
    mountBundle({
      assumptions: {
        allocation_method: 'cvm',
        weights: { asset: null, opm: null, income: null, market: null },
        dloc: null,
        dlom: null,
        dlom_method: null,
        exit_timeline: null,
      },
    });
    await screen.findByText('cvm');
    // Six unset facts plus the unset method: every one reads as a dash.
    expect(screen.getAllByText('—')).toHaveLength(7);
  });

  it('omits the assumptions and report cards when neither was recorded', async () => {
    mountBundle({ assumptions: null, report: null });
    await screen.findByText('Acme Robotics, Inc.');
    expect(screen.queryByText('Assumptions')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Report —/)).not.toBeInTheDocument();
  });

  /*
   * The audit-defense review is the reason a firm hands this link over at all:
   * a failed check has to read as failed, and be legible beside the ones that
   * passed rather than buried in a uniform list.
   */
  it('lists each review check with its own outcome', async () => {
    mountBundle({
      qa: [
        {
          id: 'qa1',
          status: 'passed_with_notes',
          checks: [
            { label: 'DLOM range', status: 'pass', detail: 'Within the 20–35% band.' },
            { label: 'Backsolve', status: 'fail', detail: 'No qualifying round within 12 months.' },
            { label: 'Peer set', status: 'n/a', detail: 'No market approach applied.' },
          ],
        },
      ],
    });

    expect(await screen.findByText('Audit-defense review')).toBeInTheDocument();
    expect(screen.getByText('Review · passed_with_notes')).toBeInTheDocument();
    expect(screen.getByText('pass')).toHaveClass('text-emerald-700');
    expect(screen.getByText('fail')).toHaveClass('text-red-700');
    expect(screen.getByText('n/a')).toHaveClass('text-ink-600');
    expect(screen.getByText('No qualifying round within 12 months.')).toBeInTheDocument();
  });

  it('omits the review card when the valuation has not been reviewed', async () => {
    mountBundle({ qa: [] });
    await screen.findByText('Acme Robotics, Inc.');
    expect(screen.queryByText('Audit-defense review')).not.toBeInTheDocument();
  });
});
