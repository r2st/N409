import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BotPromptsPage } from '../src/pages/BotPromptsPage';
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

  it('shows a forbidden note for non-ops', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/models')) return jsonResponse({ models: [] });
      return jsonResponse({ title: 'Forbidden', status: 403 }, 403);
    });
    render(<BotPromptsPage />);
    expect(await screen.findByText('Bot prompts are operations-only.')).toBeInTheDocument();
  });
});
