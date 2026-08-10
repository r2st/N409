import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter } from 'react-router-dom';
import { SampleReportPage } from '../src/pages/marketing/SampleReportPage';

/**
 * "See a sample report".
 *
 * The point of the page is that the outline comes from the deliverable's own
 * template rather than from copy written here, so the tests assert that the
 * page renders whatever the endpoint returns — including a chapter it has no
 * blurb for — rather than a list of its own.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const OUTLINE = {
  outline: {
    kind: '409a',
    version: '409a.v59',
    name: 'IRC 409A Valuation Report',
    sections: [
      { key: 'introduction', heading: 'Introduction', blurb: 'The subject and the valuation date.' },
      { key: 'dlom', heading: 'Discount for Lack of Marketability', blurb: 'Finnerty and Chaffe.' },
      { key: 'brand_new', heading: 'A Chapter With No Copy Yet', blurb: null },
    ],
    exhibits: [
      { id: 'A', title: 'Capitalization Table', description: 'Every share class.', always: true },
      { id: 'C', title: 'Income Approach', description: 'The cash-flow stream.', always: false },
    ],
  },
  figures: [
    { label: 'Equity value', value: '$31,910,519', note: 'Weighted across three approaches' },
    { label: 'FMV / share', value: '$4.10', note: 'Common stock' },
  ],
  pdf: { available: true },
};

const renderPage = () =>
  render(
    <HelmetProvider>
      <MemoryRouter>
        <SampleReportPage />
      </MemoryRouter>
    </HelmetProvider>,
  );

describe('SampleReportPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(OUTLINE)),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('renders the chapter list served by the endpoint, in order', async () => {
    renderPage();
    const list = await screen.findByTestId('sample-report-sections');
    await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(3));
    const headings = [...list.querySelectorAll('li')].map((li) => li.textContent);
    expect(headings[0]).toMatch(/Introduction/);
    expect(headings[1]).toMatch(/Discount for Lack of Marketability/);
  });

  it('names the template version it is describing', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/409a\.v59/)).toBeTruthy());
    expect(screen.getByText(/all 3 chapters/i)).toBeTruthy();
  });

  it('still shows a chapter that has no blurb, rather than dropping it', async () => {
    renderPage();
    const list = await screen.findByTestId('sample-report-sections');
    await waitFor(() => expect(list.textContent).toMatch(/A Chapter With No Copy Yet/));
  });

  it('marks conditional exhibits so the page promises no document nobody receives', async () => {
    renderPage();
    const exhibits = await screen.findByTestId('sample-report-exhibits');
    await waitFor(() => expect(exhibits.textContent).toMatch(/Exhibit A — Capitalization Table/));

    const cards = [...exhibits.children];
    const capTable = cards.find((c) => c.textContent?.includes('Capitalization Table'))!;
    const income = cards.find((c) => c.textContent?.includes('Income Approach'))!;
    expect(capTable.textContent).not.toMatch(/as applicable/i);
    expect(income.textContent).toMatch(/as applicable/i);
  });

  it('offers the rendered PDF as an ungated download', async () => {
    renderPage();
    const link = (await screen.findByTestId('sample-report-download')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/v1/sample-report/pdf');
    // Without `download` the browser opens the PDF in a tab; the CTA says
    // "Download" and has to do that.
    expect(link.getAttribute('download')).toBe('n409-sample-409a-report.pdf');
    expect(screen.getByText(/no email required/i)).toBeTruthy();
  });

  it('prints the worked example the endpoint serves, not its own copy of it', async () => {
    renderPage();
    const strip = await screen.findByTestId('sample-report-figures');
    // The figures are the PDF's conclusions. A page that hard-codes them is a
    // page that contradicts the document it is advertising the first time an
    // input to the sample changes.
    expect(strip.textContent).toMatch(/\$31,910,519/);
    expect(strip.textContent).toMatch(/\$4\.10/);
    expect(strip.textContent).toMatch(/Weighted across three approaches/);
  });

  it('hides the download for a kind that publishes no sample PDF', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ...OUTLINE, pdf: { available: false } })),
    );
    renderPage();
    await screen.findByTestId('sample-report-sections');
    expect(screen.queryByTestId('sample-report-download')).toBeNull();
    // …and the primary CTA has to survive losing it, rather than leaving the
    // page with no button on it at all.
    expect(screen.getAllByText(/Start my valuation/i).length).toBeGreaterThan(0);
  });

  it('degrades to a message rather than an empty page when the outline fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 500 }, 500)),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy());
    expect(screen.queryByTestId('sample-report-sections')).toBeNull();
    // The conversion path has to survive the outline failing.
    expect(screen.getAllByText(/Start my valuation/i).length).toBeGreaterThan(0);
  });
});
