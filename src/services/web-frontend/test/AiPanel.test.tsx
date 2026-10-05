import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiPanel } from '../src/components/valuation/AiPanel';
import { AI_PIPELINES, AI_PIPELINE_META } from '../src/lib/pipeline';

/**
 * The AI panel runs the pipelines and shows what came back, with provenance.
 *
 * Provenance is the part that matters and the part that had no tests. Every
 * run is stamped with the model, the prompt version and the latency, because
 * "the AI said so" is not a defensible input to a 409A — an analyst has to be
 * able to say which model, running which prompt, produced the number that
 * ended up in the report. The anonymization badge is the other half: it is the
 * evidence that the company name and PII were stripped before the prompt left
 * the building, and its absence has to mean they were not.
 *
 * A failed run is recorded and listed rather than swallowed, which is why
 * `run` reloads on the error path too — the failure is itself provenance.
 */

const VALUATION_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const baseJob = {
  id: 'j1',
  valuation_id: VALUATION_ID,
  pipeline: 'extract' as const,
  status: 'succeeded' as const,
  model: 'anthropic/claude-sonnet-4',
  input: { document_ids: [], documents_on_file: 0, redaction_identity: 'read' } as Record<
    string,
    unknown
  > | null,
  result: {} as Record<string, unknown>,
  error: null as string | null,
  latency_ms: 8400,
  prompt_version: 3,
  created_at: '2026-02-14T10:00:00.000Z',
  completed_at: '2026-02-14T10:00:08.000Z',
};

const extractJob = {
  ...baseJob,
  result: { engine_inputs: { revenue_ttm: 2_500_000, cash_balance: 900_000 } },
};

interface Call {
  url: string;
  method: string;
}

function mockApi(opts: { jobs?: () => Response; run?: () => Response; apply?: () => Response } = {}): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    if (/\/ai\/extract\/apply$/.test(url)) return opts.apply ? opts.apply() : json({});
    if (/\/ai\/[a-z_]+$/.test(url) && method === 'POST') return opts.run ? opts.run() : json({});
    if (/\/ai$/.test(url)) return opts.jobs ? opts.jobs() : json({ jobs: [] });
    return json({});
  });
  return calls;
}

const problem = (status: number, detail: string) => () => json({ status, title: 'Error', detail }, status);

const jobsOf =
  (...jobs: unknown[]) =>
  () =>
    json({ jobs });
const renderPanel = () => render(<AiPanel valuationId={VALUATION_ID} />);

/**
 * Every pipeline label appears twice once a run exists — on its launch card and
 * on the run itself — so run lookups are scoped to the history list.
 */
const runList = () => document.querySelector('ol') as HTMLElement;
const runsReady = async () => {
  await waitFor(() => expect(runList()).not.toBeNull());
};
/** The launch card for one pipeline, found by its label. */
const card = (label: string) => screen.getAllByText(label)[0]!.closest('div') as HTMLElement;
const jobItem = (label: string) => within(runList()).getByText(label).closest('li') as HTMLElement;

describe('AiPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('loading', () => {
    it('waits for the run history', async () => {
      mockApi();
      renderPanel();
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(await screen.findByText('No AI runs yet')).toBeInTheDocument();
    });

    it('surfaces the server detail on a failed load', async () => {
      mockApi({ jobs: problem(503, 'The AI service is temporarily unavailable.') });
      renderPanel();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The AI service is temporarily unavailable.',
      );
    });

    it('falls back to the generic message when the server sends no detail', async () => {
      mockApi({ jobs: () => json({ status: 500, title: 'Internal Server Error' }, 500) });
      renderPanel();
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load AI runs.');
    });

    /**
     * Driven from `AI_PIPELINES` rather than from a list retyped here. The
     * literal `5` was the count on the day it was written, and R178 found four
     * agents that were fully built and had no control anywhere — adding them
     * failed this on the number rather than on anything being wrong, which is
     * the assertion asking to be rephrased. What actually has to hold is that
     * every agent on the tab is named, described and runnable.
     */
    it('offers every pipeline, described', async () => {
      mockApi();
      renderPanel();
      await screen.findByText('No AI runs yet');
      for (const pipeline of AI_PIPELINES) {
        const meta = AI_PIPELINE_META[pipeline];
        expect(screen.getByText(meta.label), pipeline).toBeInTheDocument();
        expect(screen.getByText(meta.description), pipeline).toBeInTheDocument();
      }
      expect(screen.getAllByRole('button', { name: 'Run' })).toHaveLength(AI_PIPELINES.length);
      // Not vacuous on an empty registry, and not silently reduced to one card.
      expect(AI_PIPELINES.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe('running a pipeline', () => {
    it('posts to the pipeline it was asked for and re-reads the history', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderPanel();
      await screen.findByText('No AI runs yet');
      await user.click(within(card('Data extraction')).getByRole('button', { name: 'Run' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
      expect(calls.find((c) => c.method === 'POST')!.url).toMatch(/\/ai\/extract$/);
      await waitFor(() => expect(calls.filter((c) => /\/ai$/.test(c.url))).toHaveLength(2));
    });

    it('locks every other pipeline while one is in flight', async () => {
      // The pipelines write to the same params; two at once is a race the
      // panel should not be able to start.
      const user = userEvent.setup();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      mockApi({
        run: () => json({}),
        jobs: jobsOf(),
      });
      const original = globalThis.fetch as typeof fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if ((init?.method ?? 'GET') === 'POST') {
          await held;
          return json({});
        }
        return original(input, init);
      });
      renderPanel();
      await screen.findByText('No AI runs yet');
      await user.click(within(card('Data extraction')).getByRole('button', { name: 'Run' }));
      await screen.findByText(/Running data extraction/);
      for (const button of screen.getAllByRole('button', { name: /^(Run|Running…)$/ })) {
        expect(button).toBeDisabled();
      }
      release();
    });

    it('says which pipeline is running, and warns it may be slow', async () => {
      const user = userEvent.setup();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      mockApi({ jobs: jobsOf() });
      const original = globalThis.fetch as typeof fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if ((init?.method ?? 'GET') === 'POST') {
          await held;
          return json({});
        }
        return original(input, init);
      });
      renderPanel();
      await screen.findByText('No AI runs yet');
      await user.click(within(card('Public comparables')).getByRole('button', { name: 'Run' }));
      expect(
        await screen.findByText(/Running public comparables — free-tier models can take up to a minute/),
      ).toBeInTheDocument();
      release();
    });

    it('reports a failed run and still re-reads the history', async () => {
      // A failed run is recorded server-side, and the record is itself
      // provenance — so the list is refreshed on the error path too.
      const user = userEvent.setup();
      const calls = mockApi({ run: problem(502, 'The model is rate limited.') });
      renderPanel();
      await screen.findByText('No AI runs yet');
      await user.click(within(card('Data extraction')).getByRole('button', { name: 'Run' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The model is rate limited.');
      await waitFor(() => expect(calls.filter((c) => /\/ai$/.test(c.url))).toHaveLength(2));
    });
  });

  describe('provenance', () => {
    it('stamps each run with the model, prompt version and latency', async () => {
      // "The AI said so" is not a defensible input to a 409A. Which model,
      // running which prompt, is.
      mockApi({ jobs: jobsOf(extractJob) });
      renderPanel();
      await runsReady();
      const item = jobItem('Data extraction');
      expect(item).toHaveTextContent('anthropic/claude-sonnet-4');
      expect(item).toHaveTextContent('prompt v3');
      expect(item).toHaveTextContent('8.4s');
    });

    it('omits what was never recorded rather than printing null', async () => {
      mockApi({
        jobs: jobsOf({ ...extractJob, model: null, prompt_version: null, latency_ms: null }),
      });
      renderPanel();
      await runsReady();
      const item = jobItem('Data extraction');
      expect(item).not.toHaveTextContent('null');
      expect(item).not.toHaveTextContent('prompt v');
    });

    it('badges a run whose prompt was anonymized, with the redaction count', async () => {
      mockApi({
        jobs: jobsOf({
          ...extractJob,
          result: {
            ...extractJob.result,
            anonymization: { applied: true, redacted: { person: 2, email: 3 } },
          },
        }),
      });
      renderPanel();
      await runsReady();
      const badge = screen.getByText('anonymized · 5');
      expect(badge).toHaveAttribute('title', expect.stringContaining('redacted out of the whole prompt'));
    });

    it('badges an anonymized run that redacted nothing, without a count', async () => {
      mockApi({
        jobs: jobsOf({
          ...extractJob,
          result: { ...extractJob.result, anonymization: { applied: true, redacted: {} } },
        }),
      });
      renderPanel();
      await runsReady();
      expect(screen.getByText('anonymized')).toBeInTheDocument();
    });

    /*
     * "anonymized" was one word for two runs that are not the same run. The
     * redactor strikes what a pattern can key on and what it is *told*, and the
     * engagement owner's bare name is only in the second half — so a failed
     * owner lookup ships that name to an external model while the badge still
     * reads anonymized and the count still moves. `declared: {people: 0}` could
     * not carry the difference, because an account with no name on file
     * produces exactly that.
     */
    it('warns when the run could not be told who the engagement is for', async () => {
      mockApi({
        jobs: jobsOf({
          ...extractJob,
          input: { ...(extractJob.input ?? {}), redaction_identity: 'unavailable' },
          result: {
            ...extractJob.result,
            anonymization: { applied: true, redacted: { email: 3 }, declared: { companies: 0, people: 0 } },
          },
        }),
      });
      renderPanel();
      await runsReady();
      expect(screen.getByText('anonymized · 3')).toBeInTheDocument();
      const warning = screen.getByText('owner not struck');
      expect(warning).toHaveAttribute('title', expect.stringContaining('could not be read'));
    });

    it('does not warn when the owner was read but had nothing to strike', async () => {
      // The ordinary shape for an account with no name on file: redaction did
      // everything it was asked to. A warning here would be noise on most runs,
      // which is how the one that matters stops being read.
      mockApi({
        jobs: jobsOf({
          ...extractJob,
          input: { ...(extractJob.input ?? {}), redaction_identity: 'read' },
          result: {
            ...extractJob.result,
            anonymization: { applied: true, redacted: {}, declared: { companies: 0, people: 0 } },
          },
        }),
      });
      renderPanel();
      await runsReady();
      expect(screen.getByText('anonymized')).toBeInTheDocument();
      expect(screen.queryByText('owner not struck')).not.toBeInTheDocument();
    });

    it('shows no badge when anonymization was not applied', async () => {
      // Absence has to mean it did not happen — a badge that showed either way
      // would be worse than none.
      mockApi({
        jobs: jobsOf({
          ...extractJob,
          result: { ...extractJob.result, anonymization: { applied: false, redacted: {} } },
        }),
      });
      renderPanel();
      await runsReady();
      expect(screen.queryByText(/^anonymized/)).not.toBeInTheDocument();
    });

    it('marks each run with its status', async () => {
      mockApi({
        jobs: jobsOf(
          extractJob,
          { ...baseJob, id: 'j2', pipeline: 'summarize', status: 'failed', error: 'Timed out.' },
          { ...baseJob, id: 'j3', pipeline: 'comparables', status: 'running' },
        ),
      });
      renderPanel();
      await runsReady();
      expect(screen.getByText('succeeded')).toBeInTheDocument();
      expect(screen.getByText('failed')).toBeInTheDocument();
      expect(screen.getByText('running')).toBeInTheDocument();
    });
  });

  describe('what each pipeline returned', () => {
    it('shows a failed run’s error in place of a result', async () => {
      mockApi({ jobs: jobsOf({ ...baseJob, status: 'failed', error: 'The model returned no JSON.' }) });
      renderPanel();
      await runsReady();
      expect(screen.getByText('The model returned no JSON.')).toBeInTheDocument();
    });

    it('falls back to a generic message for a failure with no error text', async () => {
      mockApi({ jobs: jobsOf({ ...baseJob, status: 'failed', error: null }) });
      renderPanel();
      await runsReady();
      expect(screen.getByText('Pipeline failed.')).toBeInTheDocument();
    });

    it('lists extracted inputs with their keys read as words', async () => {
      mockApi({ jobs: jobsOf(extractJob) });
      renderPanel();
      await runsReady();
      expect(screen.getByText('revenue ttm')).toBeInTheDocument();
      expect(screen.getByText('2,500,000')).toBeInTheDocument();
      expect(screen.getByText('cash balance')).toBeInTheDocument();
    });

    it('says so when extraction found nothing', async () => {
      mockApi({ jobs: jobsOf({ ...baseJob, result: { engine_inputs: {} } }) });
      renderPanel();
      await runsReady();
      expect(screen.getByText('No values could be extracted.')).toBeInTheDocument();
    });

    it('lists missing documents, params and gaps together', async () => {
      mockApi({
        jobs: jobsOf({
          ...baseJob,
          pipeline: 'missing_data',
          result: {
            missing_documents: [{ label: 'Cap table export' }],
            missing_params: [{ label: 'Discount rate' }],
            gaps: [{ item: 'No audited financials', severity: 'blocking' }],
            notes: 'Ask the client for the 2025 statements.',
          },
        }),
      });
      renderPanel();
      await runsReady();
      expect(screen.getByText('Cap table export')).toBeInTheDocument();
      expect(screen.getByText('Discount rate')).toBeInTheDocument();
      expect(screen.getByText('No audited financials')).toBeInTheDocument();
      expect(screen.getByText('Ask the client for the 2025 statements.')).toBeInTheDocument();
    });

    it('says plainly when nothing is missing', async () => {
      mockApi({ jobs: jobsOf({ ...baseJob, pipeline: 'missing_data', result: {} }) });
      renderPanel();
      await runsReady();
      expect(screen.getByText('Nothing missing — ready to compute.')).toBeInTheDocument();
    });

    it('shows per-document summaries under an overall one', async () => {
      mockApi({
        jobs: jobsOf({
          ...baseJob,
          pipeline: 'summarize',
          result: {
            overall: 'Three documents, all consistent.',
            summaries: [
              { filename: 'charter.pdf', summary: 'Delaware C-corp.', key_figures: ['10,000,000 shares'] },
            ],
          },
        }),
      });
      renderPanel();
      await runsReady();
      expect(screen.getByText('Three documents, all consistent.')).toBeInTheDocument();
      expect(screen.getByText('charter.pdf')).toBeInTheDocument();
      expect(screen.getByText('· 10,000,000 shares')).toBeInTheDocument();
    });

    it('says so when there is nothing to summarize', async () => {
      mockApi({ jobs: jobsOf({ ...baseJob, pipeline: 'summarize', result: {} }) });
      renderPanel();
      await runsReady();
      expect(screen.getByText('Nothing to summarize yet.')).toBeInTheDocument();
    });

    it('tabulates comparables with their multiples and rationale', async () => {
      mockApi({
        jobs: jobsOf({
          ...baseJob,
          pipeline: 'comparables',
          result: {
            sector: 'Industrial robotics',
            caveats: 'Multiples as at the valuation date.',
            comparables: [
              {
                name: 'Robo Corp',
                ticker: 'RBO',
                rationale: 'Same end market.',
                revenue_multiple: 4.2,
                ebitda_multiple: null,
              },
            ],
          },
        }),
      });
      renderPanel();
      await runsReady();
      expect(screen.getByText('Sector: Industrial robotics')).toBeInTheDocument();
      const row = screen.getByText('RBO').closest('tr') as HTMLElement;
      expect(row).toHaveTextContent('Robo Corp');
      expect(row).toHaveTextContent('4.2');
      // A missing multiple reads as an em dash, not as a zero.
      expect(within(row).getByText('—')).toBeInTheDocument();
      expect(screen.getByText('Multiples as at the valuation date.')).toBeInTheDocument();
    });
  });

  describe('applying an extraction', () => {
    it('is offered only once an extraction has succeeded', async () => {
      mockApi({ jobs: jobsOf({ ...baseJob, pipeline: 'summarize' }) });
      renderPanel();
      await runsReady();
      expect(screen.queryByRole('button', { name: 'Apply to params' })).not.toBeInTheDocument();
    });

    it('is not offered for an extraction that failed', async () => {
      mockApi({ jobs: jobsOf({ ...baseJob, status: 'failed', error: 'nope' }) });
      renderPanel();
      await runsReady();
      expect(screen.queryByRole('button', { name: 'Apply to params' })).not.toBeInTheDocument();
    });

    it('applies the extraction to the params', async () => {
      const user = userEvent.setup();
      const calls = mockApi({ jobs: jobsOf(extractJob) });
      renderPanel();
      await runsReady();
      await user.click(screen.getByRole('button', { name: 'Apply to params' }));
      await waitFor(() => expect(calls.some((c) => /\/ai\/extract\/apply$/.test(c.url))).toBe(true));
      expect(await screen.findByText('Applied ✓')).toBeInTheDocument();
    });

    it('offers a re-apply once it has been applied', async () => {
      const user = userEvent.setup();
      mockApi({ jobs: jobsOf(extractJob) });
      renderPanel();
      await runsReady();
      await user.click(screen.getByRole('button', { name: 'Apply to params' }));
      expect(await screen.findByRole('button', { name: 'Re-apply to params' })).toBeInTheDocument();
    });

    it('reports a refused apply and does not claim it worked', async () => {
      const user = userEvent.setup();
      mockApi({ jobs: jobsOf(extractJob), apply: problem(409, 'The valuation is locked.') });
      renderPanel();
      await runsReady();
      await user.click(screen.getByRole('button', { name: 'Apply to params' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The valuation is locked.');
      expect(screen.queryByText('Applied ✓')).not.toBeInTheDocument();
    });
  });
});
