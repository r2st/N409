import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotPromptsPage } from '../src/pages/BotPromptsPage';
import type { BotPrompt, PromptVersion } from '../src/pages/BotPromptsPage';

/**
 * The half of the bot-prompt registry that only exists once someone opens the
 * `<details>`: the version history, its diff, and the revert that writes a new
 * version. A prompt edit is a production behaviour change with no deploy
 * attached, so the trail of who changed what — and the ability to put it back —
 * is the only thing standing between a bad wording and a silent regression.
 */

const PROMPT_ID = '01N409PR0MPT000000000000EX';
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const prompt: BotPrompt = {
  id: PROMPT_ID,
  pipeline: 'extract',
  label: 'Data extraction',
  description: 'Pulls numbers out of documents.',
  system_prompt: 'Extract only.\nJSON only.',
  model: null,
  updated_at: '2026-07-01T10:00:00Z',
};

const versions: PromptVersion[] = [
  {
    id: 'v2',
    prompt_id: PROMPT_ID,
    version: 2,
    system_prompt: 'Extract only.\nJSON only.',
    model: 'openai/gpt-4o-mini',
    created_by_email: 'ops@n409.ai',
    created_at: '2026-07-01T10:00:00Z',
  },
  {
    id: 'v1',
    prompt_id: PROMPT_ID,
    version: 1,
    system_prompt: 'Extract everything.\nProse is fine.',
    model: null,
    created_by_email: null,
    created_at: '2026-06-01T09:00:00Z',
  },
];

/**
 * Routes by exact method+path. Overrides win, so a case can make one call fail
 * while the rest of the page still loads — the shape every failure test here
 * needs. Matching is exact rather than by substring because `/admin/prompts` is
 * a prefix of every other route on this page, `/admin/prompts/models` included.
 */
function mockApi(overrides: Record<string, (init?: RequestInit) => Response> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${String(url).replace(/^.*\/api\/v1/, '')}`;
    const override = overrides[key];
    if (override) return override(init);
    if (key === 'GET /admin/prompts/models') return jsonResponse({ models: ['a/b', 'c/d'] });
    if (key === 'GET /admin/prompts') return jsonResponse({ prompts: [prompt] });
    if (key === `GET /admin/prompts/${PROMPT_ID}/versions`) return jsonResponse({ versions });
    throw new Error(`unexpected fetch ${key}`);
  });
}

/** Render, then open the collapsed version history and wait for its first row. */
async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  render(<BotPromptsPage />);
  await user.click(await screen.findByText('Version history'));
}

describe('BotPromptsPage — version history', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('loads on first open and names the author, model and time of each version', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockApi();
    await openHistory(user);

    expect(await screen.findByText('v2')).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();
    // Only the newest carries the "current" badge — the whole point of the row
    // is telling apart what is running from what merely ran once.
    expect(screen.getAllByText('current')).toHaveLength(1);
    expect(screen.getByText('openai/gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByText(/^ops@n409\.ai ·/)).toBeInTheDocument();
    // A version written by a migration rather than a person still needs an
    // author on screen; "system" is the honest one.
    expect(screen.getByText(/^system ·/)).toBeInTheDocument();

    // Only the version that is not current offers a revert.
    expect(screen.getAllByRole('button', { name: 'Revert' })).toHaveLength(1);

    // Opening again must not re-fetch — the list is loaded once and kept.
    await user.click(screen.getByText('Version history'));
    await user.click(screen.getByText('Version history'));
    const versionCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/versions'));
    expect(versionCalls).toHaveLength(1);
  });

  it('diffs a version against the live content, and says so when there is nothing to show', async () => {
    const user = userEvent.setup();
    mockApi();
    await openHistory(user);
    await screen.findByText('v1');

    const rows = screen.getAllByRole('button', { name: 'Diff' });
    // v1 differs from what is live: both sides of the change are on screen.
    await user.click(rows[1]!);
    expect(await screen.findByText(/^− ?Extract everything\.$/)).toBeInTheDocument();
    expect(screen.getByText(/^\+ ?Extract only\.$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide diff' })).toBeInTheDocument();

    // v2 *is* the live content — an empty diff pane would read as a broken
    // button, so the panel says outright that there is no difference.
    await user.click(screen.getAllByRole('button', { name: 'Diff' })[0]!);
    expect(await screen.findByText('Identical to the current content.')).toBeInTheDocument();

    // The two panes are mutually exclusive: opening one closes the other.
    expect(screen.queryByText(/^− ?Extract everything\.$/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide diff' }));
    expect(screen.queryByText('Identical to the current content.')).not.toBeInTheDocument();
  });

  it('asks before reverting, and does nothing when the answer is no', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockApi();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openHistory(user);
    await screen.findByText('v1');

    await user.click(screen.getByRole('button', { name: 'Revert' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Restore version 1?'));
    expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('reverts to a chosen version and refreshes both the editor and the history', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const reverted: BotPrompt = {
      ...prompt,
      system_prompt: 'Extract everything.\nProse is fine.',
      model: 'anthropic/claude',
      updated_at: '2026-07-02T11:00:00Z',
    };
    let listReverted = false;
    const fetchSpy = mockApi({
      [`POST /admin/prompts/${PROMPT_ID}/revert`]: () => {
        listReverted = true;
        return jsonResponse({ prompt: reverted });
      },
      'GET /admin/prompts': () => jsonResponse({ prompts: [listReverted ? reverted : prompt] }),
    });
    await openHistory(user);
    await screen.findByText('v1');

    await user.click(screen.getByRole('button', { name: 'Revert' }));

    await waitFor(() => {
      const post = fetchSpy.mock.calls.find(
        ([u, init]) => init?.method === 'POST' && String(u).includes('/revert'),
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ version: 1 });
    });

    // The editor above the history now holds what was restored — otherwise the
    // next save would quietly push the old wording back over the revert.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'System prompt' })).toHaveValue(
        'Extract everything.\nProse is fine.',
      ),
    );
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('anthropic/claude');
  });

  it('reports a failed revert with the server’s own words', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockApi({
      [`POST /admin/prompts/${PROMPT_ID}/revert`]: () =>
        jsonResponse({ title: 'Conflict', detail: 'That version has been pruned.', status: 409 }, 409),
    });
    await openHistory(user);
    await screen.findByText('v1');

    await user.click(screen.getByRole('button', { name: 'Revert' }));
    expect(await screen.findByText('That version has been pruned.')).toBeInTheDocument();
  });

  it('falls back to its own wording when a revert fails without a problem document', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockApi({
      [`POST /admin/prompts/${PROMPT_ID}/revert`]: () => {
        throw new TypeError('network down');
      },
    });
    await openHistory(user);
    await screen.findByText('v1');

    await user.click(screen.getByRole('button', { name: 'Revert' }));
    expect(await screen.findByText('Could not revert the prompt.')).toBeInTheDocument();
  });

  it('reports a history that will not load instead of spinning', async () => {
    const user = userEvent.setup();
    mockApi({ [`GET /admin/prompts/${PROMPT_ID}/versions`]: () => jsonResponse({ status: 500 }, 500) });
    await openHistory(user);

    expect(await screen.findByText('Could not load the version history.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says a prompt with no history yet has none, rather than showing an empty box', async () => {
    const user = userEvent.setup();
    mockApi({ [`GET /admin/prompts/${PROMPT_ID}/versions`]: () => jsonResponse({ versions: [] }) });
    await openHistory(user);

    expect(
      await screen.findByText('No versions yet — save a change to start the history.'),
    ).toBeInTheDocument();
  });
});

describe('BotPromptsPage — editing failures and the empty registry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('surfaces a rejected save and keeps the edit in the box', async () => {
    const user = userEvent.setup();
    mockApi({
      [`PATCH /admin/prompts/${PROMPT_ID}`]: () =>
        jsonResponse({ title: 'Bad Request', detail: 'system_prompt is too long.', status: 400 }, 400),
    });
    render(<BotPromptsPage />);

    const box = await screen.findByRole('textbox', { name: 'System prompt' });
    await user.type(box, ' Be terse.');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('system_prompt is too long.')).toBeInTheDocument();
    // The rejected text is still there to fix — a save that clears the box on
    // failure loses the work that caused the failure.
    expect(box).toHaveValue('Extract only.\nJSON only. Be terse.');
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });

  it('reports a save that failed without a problem document', async () => {
    const user = userEvent.setup();
    mockApi({
      [`PATCH /admin/prompts/${PROMPT_ID}`]: () => {
        throw new TypeError('network down');
      },
    });
    render(<BotPromptsPage />);

    await user.type(await screen.findByRole('textbox', { name: 'System prompt' }), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Could not save the prompt.')).toBeInTheDocument();
  });

  it('confirms a successful save and settles back to a clean form', async () => {
    const user = userEvent.setup();
    const saved = { ...prompt, system_prompt: 'Extract only.\nJSON only.!' };
    let done = false;
    mockApi({
      [`PATCH /admin/prompts/${PROMPT_ID}`]: () => {
        done = true;
        return jsonResponse({ prompt: saved });
      },
      'GET /admin/prompts': () => jsonResponse({ prompts: [done ? saved : prompt] }),
    });
    render(<BotPromptsPage />);

    await user.type(await screen.findByRole('textbox', { name: 'System prompt' }), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('pins a model from the suggestion list and sends it trimmed', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockApi({
      [`PATCH /admin/prompts/${PROMPT_ID}`]: () => jsonResponse({ prompt }),
    });
    render(<BotPromptsPage />);

    // `list` puts the model box in the combobox role — it offers the models the
    // AI service reports while still accepting anything typed.
    const modelBox = await screen.findByRole('combobox', { name: 'Model' });
    await user.type(modelBox, '  a/b  ');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const patch = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(String((patch![1] as RequestInit).body)).model).toBe('a/b');
    });
  });

  it('renames a prompt through the label field', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockApi({
      [`PATCH /admin/prompts/${PROMPT_ID}`]: () => jsonResponse({ prompt }),
    });
    render(<BotPromptsPage />);

    const labelBox = await screen.findByRole('textbox', { name: 'Label' });
    await user.clear(labelBox);
    await user.type(labelBox, 'Document extraction');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const patch = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(String((patch![1] as RequestInit).body)).label).toBe('Document extraction');
    });
  });

  it('reports a failed dry run rather than leaving the button spinning', async () => {
    const user = userEvent.setup();
    mockApi({
      [`POST /admin/prompts/${PROMPT_ID}/test`]: () =>
        jsonResponse(
          { title: 'Bad Gateway', detail: 'The model provider is out of quota.', status: 502 },
          502,
        ),
    });
    render(<BotPromptsPage />);

    await user.click(await screen.findByText('Test this prompt'));
    await user.type(screen.getByPlaceholderText(/Company: Acme/), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Run test' }));

    expect(await screen.findByText('The model provider is out of quota.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run test' })).toBeEnabled();
  });

  it('reports a dry run that failed without a problem document', async () => {
    const user = userEvent.setup();
    mockApi({
      [`POST /admin/prompts/${PROMPT_ID}/test`]: () => {
        throw new TypeError('network down');
      },
    });
    render(<BotPromptsPage />);

    await user.click(await screen.findByText('Test this prompt'));
    await user.type(screen.getByPlaceholderText(/Company: Acme/), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Run test' }));
    expect(await screen.findByText('The test run failed.')).toBeInTheDocument();
  });

  it('will not dry-run an unsaved edit, because the run uses the saved prompt', async () => {
    const user = userEvent.setup();
    mockApi();
    render(<BotPromptsPage />);

    await user.click(await screen.findByText('Test this prompt'));
    await user.type(screen.getByPlaceholderText(/Company: Acme/), 'Acme');
    expect(screen.getByRole('button', { name: 'Run test' })).toBeEnabled();

    await user.type(screen.getByRole('textbox', { name: 'System prompt' }), ' More.');
    expect(screen.getByRole('button', { name: 'Save before testing' })).toBeDisabled();
  });

  it('tells ops how to seed an empty registry', async () => {
    mockApi({ 'GET /admin/prompts': () => jsonResponse({ prompts: [] }) });
    render(<BotPromptsPage />);

    expect(await screen.findByText('No prompts registered')).toBeInTheDocument();
    expect(screen.getByText(/Run the database migrations/)).toBeInTheDocument();
  });

  it('distinguishes a registry that failed to load from one that is forbidden', async () => {
    mockApi({ 'GET /admin/prompts': () => jsonResponse({ title: 'Server Error', status: 500 }, 500) });
    render(<BotPromptsPage />);

    expect(await screen.findByText('Could not load the prompt registry.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders each registered prompt as its own card', async () => {
    const second: BotPrompt = {
      ...prompt,
      id: '01N409PR0MPT000000000000NA',
      pipeline: 'narrative',
      label: 'Narrative drafting',
      description: null,
      model: 'c/d',
    };
    mockApi({ 'GET /admin/prompts': () => jsonResponse({ prompts: [prompt, second] }) });
    render(<BotPromptsPage />);

    const cards = await screen.findAllByRole('heading', { level: 2 });
    expect(cards.map((h) => h.textContent)).toEqual(['Data extraction', 'Narrative drafting']);
    // A prompt with no description simply has none — not an empty paragraph.
    const narrative = within(cards[1]!.closest('section')!);
    expect(narrative.queryByText('Pulls numbers out of documents.')).not.toBeInTheDocument();
  });
});
