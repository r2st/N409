import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { CommandPalette } from '../src/components/CommandPalette';
import type { User } from '../src/lib/types';

/** ⌘K command palette (feature-improvements §2, ranked #7). */

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const makeUser = (roles: string[]): User => ({
  id: 'me-1',
  email: 'me@409.ai',
  first_name: 'Mo',
  last_name: 'Admin',
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles,
});

const searchBody = {
  valuations: [
    {
      id: 'v-42',
      number: 'V-0042',
      kind: '409a',
      state: 'in_progress',
      company_name: 'Northwind Robotics',
      service_name: '409A Valuation',
      created_at: '2026-01-05T00:00:00.000Z',
    },
  ],
  users: [],
};

function mockApi(user: User, onSearch?: (url: string) => void) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/auth/me')) return jsonResponse({ user });
    if (path.includes('/search?')) {
      onSearch?.(path);
      return jsonResponse(searchBody);
    }
    return jsonResponse({});
  });
}

function Probe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderPalette(roles: string[], initialPath = '/dashboard', onSearch?: (url: string) => void) {
  mockApi(makeUser(roles), onSearch);
  localStorage.setItem('n409.token', 'header.payload.sig');
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Probe />
        <Routes>
          <Route path="*" element={<CommandPalette />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const open = async () => {
  await userEvent.keyboard('{Meta>}k{/Meta}');
  return screen.findByRole('dialog', { name: 'Command palette' });
};

describe('CommandPalette', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('stays closed until ⌘K, and closes again on Escape', async () => {
    renderPalette(['admin']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await open();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens on a bare "/" but not while the user is typing in a field', async () => {
    renderPalette(['admin']);
    await userEvent.keyboard('/');
    await screen.findByRole('dialog', { name: 'Command palette' });
    await userEvent.keyboard('{Escape}');

    // Inside the palette's own input, "/" must be a literal character.
    await open();
    const input = screen.getByRole('textbox', { name: 'Search commands' });
    await userEvent.type(input, 'a/b');
    expect(input).toHaveValue('a/b');
  });

  it('filters commands as you type and navigates on Enter', async () => {
    renderPalette(['admin']);
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: 'Search commands' }), 'sso');

    const option = await screen.findByRole('option', { name: /Enterprise SSO/ });
    expect(option).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/admin/sso'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves the cursor with the arrow keys', async () => {
    renderPalette(['admin']);
    await open();
    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    // Wraps at the top edge.
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    const all = screen.getAllByRole('option');
    expect(all[all.length - 1]).toHaveAttribute('aria-selected', 'true');
  });

  it('offers the open valuation’s tabs and jumps into one', async () => {
    renderPalette(['admin'], '/valuations/v-9001/params');
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: 'Search commands' }), 'workbook');
    await userEvent.click(await screen.findByRole('option', { name: /Workbook/ }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/valuations/v-9001/workbook'));
  });

  it('adds live valuation hits below the local commands', async () => {
    const seen: string[] = [];
    renderPalette(['admin'], '/dashboard', (u) => seen.push(u));
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: 'Search commands' }), 'Northwind');

    const hit = await screen.findByRole('option', { name: /Northwind Robotics/ });
    expect(seen.some((u) => u.includes('q=Northwind'))).toBe(true);

    await userEvent.click(hit);
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/valuations/v-42'));
  });

  it('does not call search for a one-character query', async () => {
    const seen: string[] = [];
    renderPalette(['admin'], '/dashboard', (u) => seen.push(u));
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: 'Search commands' }), 'n');
    await new Promise((r) => setTimeout(r, 350));
    expect(seen).toHaveLength(0);
  });

  it('remembers what you picked and floats it next time', async () => {
    const { unmount } = renderPalette(['admin']);
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: 'Search commands' }), 'billing');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/billing'));
    unmount();

    renderPalette(['admin']);
    await open();
    // With no query the list is recents-first.
    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveTextContent('Billing');
  });

  it('shows a client only what a client may reach', async () => {
    renderPalette(['valuation_user']);
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: 'Search commands' }), 'users');
    expect(screen.queryByRole('option', { name: /Users & roles/ })).not.toBeInTheDocument();
  });
});
