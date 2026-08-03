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
