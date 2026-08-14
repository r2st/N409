import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotPromptsPage, describeRedactions } from '../src/pages/BotPromptsPage';
import type { BotPrompt } from '../src/pages/BotPromptsPage';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const prompts: BotPrompt[] = [
  {
    id: '01N409PR0MPT000000000000EX',
    pipeline: 'extract',
    label: 'Data extraction',
    description: 'Pulls numbers out of documents.',
    system_prompt: 'Extract only. JSON only.',
    model: null,
    updated_at: '2026-07-01T10:00:00Z',
  },
];

function mockApi(overrides: Record<string, (init?: RequestInit) => Response> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    for (const [needle, handler] of Object.entries(overrides)) {
      if (path.includes(needle) && (init?.method ?? 'GET') !== 'GET') return handler(init);
    }
    if (path.endsWith('/admin/prompts/models')) return jsonResponse({ models: ['a/b', 'c/d'] });
    if (path.endsWith('/admin/prompts')) return jsonResponse({ prompts });
    throw new Error(`unexpected fetch ${path}`);
  });
}

describe('describeRedactions', () => {
  it('is null when there is nothing to say', () => {
    expect(describeRedactions(undefined)).toBeNull();
    expect(describeRedactions({})).toBeNull();
    // A category present but zero is the same as absent — a "0 email
    // addresses" notice would read as a warning about nothing.
    expect(describeRedactions({ emails: 0 })).toBeNull();
  });

  it('agrees in number with what it counted', () => {
    expect(describeRedactions({ emails: 1 })).toBe('1 email address');
    expect(describeRedactions({ emails: 3 })).toBe('3 email addresses');
    expect(describeRedactions({ ssns: 1 })).toBe('1 SSN');
  });

  it('joins categories as a sentence, not a list', () => {
    // Keys deliberately out of alphabetical order: the AI service builds its
    // counts in whatever order its detectors happened to fire, and a notice
    // that reshuffles itself between two runs of the same prompt reads as the
    // redaction having changed when only the input did.
    expect(describeRedactions({ phones: 1, emails: 2 })).toBe('2 email addresses and 1 phone number');
    expect(describeRedactions({ phones: 1, emails: 1, names: 1 })).toBe(
      '1 email address, 1 name and 1 phone number',
    );
  });

  it('names a category it has never heard of rather than dropping it', () => {
    // The AI service can add a detector without this page shipping first, and
    // a silently omitted category is exactly the kind of thing ops needs told.
    expect(describeRedactions({ passports: 2 })).toBe('2 passports');
  });
});

describe('BotPromptsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders the registry with pipeline metadata', async () => {
    mockApi();
    render(<BotPromptsPage />);
    expect(await screen.findByText('Data extraction')).toBeInTheDocument();
    expect(screen.getByText('extract')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Extract only. JSON only.')).toBeInTheDocument();
  });

  it('saves edits via PATCH and disables save until dirty', async () => {
    const user = userEvent.setup();
    const patched = { ...prompts[0], system_prompt: 'Extract only. JSON only. Be terse.' };
    const fetchSpy = mockApi({
      '/admin/prompts/01N409PR0MPT000000000000EX': () => jsonResponse({ prompt: patched }),
    });
    render(<BotPromptsPage />);

    const save = await screen.findByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await user.type(screen.getByDisplayValue('Extract only. JSON only.'), ' Be terse.');
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => {
      const patchCall = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(String((patchCall![1] as RequestInit).body));
      expect(body.system_prompt).toBe('Extract only. JSON only. Be terse.');
      expect(body.model).toBeNull();
    });
  });

  // The dry-run box redacts what ops pastes into it before the AI service
  // sends it on. Someone tuning prompt wording is then reading the model's
  // answer to text they only *think* they sent — so what was struck has to be
  // on screen next to the answer, or the next twenty minutes go into rewording
  // a prompt that handled the input fine.
  describe('the redaction notice on a dry run', () => {
    const runTest = async (test: unknown) => {
      const user = userEvent.setup();
      mockApi({ '/test': () => jsonResponse({ test }) });
      render(<BotPromptsPage />);
      await user.click(await screen.findByText('Test this prompt'));
      await user.type(screen.getByPlaceholderText(/Company: Acme/), 'Acme, ada@acme.io');
      await user.click(screen.getByRole('button', { name: 'Run test' }));
      return screen.findByText('{"ok": true}');
    };

    it('names what was struck, in the words of the thing struck', async () => {
      await runTest({
        model: 'a/b',
        content: '{"ok": true}',
        anonymization: { applied: true, redacted: { emails: 2, phones: 1 }, enforced: false },
      });
      expect(
        screen.getByText(/Redacted before sending: 2 email addresses and 1 phone number\./),
      ).toBeInTheDocument();
    });

    it('says nothing when nothing was struck', async () => {
      await runTest({
        model: 'a/b',
        content: '{"ok": true}',
        anonymization: { applied: true, redacted: {}, enforced: false },
      });
      expect(screen.queryByText(/Redacted before sending/)).not.toBeInTheDocument();
    });

    it('still shows the response when the service reports no redaction at all', async () => {
      // An older AI service, mid-deploy, omits the field entirely.
      await runTest({ model: 'a/b', content: '{"ok": true}' });
      expect(screen.queryByText(/Redacted before sending/)).not.toBeInTheDocument();
    });
  });

  it('says a prompt has no earlier versions rather than opening an empty panel', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/versions')) return jsonResponse({ versions: [] });
      if (path.endsWith('/admin/prompts/models')) return jsonResponse({ models: ['a/b'] });
      if (path.endsWith('/admin/prompts')) return jsonResponse({ prompts });
      throw new Error(`unexpected fetch ${path}`);
    });
    render(<BotPromptsPage />);

    // The history is behind a <details>; opening it is what triggers the load.
    await userEvent.click(await screen.findByText('Version history'));
    expect(
      await screen.findByText(/this prompt has not been edited since it was created/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a forbidden note for non-ops', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/models')) return jsonResponse({ models: [] });
      return jsonResponse({ title: 'Forbidden', status: 403 }, 403);
    });
    render(<BotPromptsPage />);
    expect(await screen.findByText('Bot prompts are operations-only.')).toBeInTheDocument();
  });
});
