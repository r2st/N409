import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SettingsPage } from '../src/pages/SettingsPage';
import type { User } from '../src/lib/types';

const clientUser = {
  id: '01N409USER00000000000000CL',
  email: 'client@example.com',
  first_name: 'Cleo',
  last_name: 'Client',
  roles: ['valuation_user'],
} as unknown as User;

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: clientUser }),
}));

describe('SettingsPage help link', () => {
  it('renders a contextual HelpIcon in the header that opens the settings article', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    const help = await screen.findByRole('button', { name: /Help: Settings/ });
    await user.click(help);

    await screen.findByRole('dialog', { name: /Settings/ });
    expect(screen.getByRole('link', { name: /Open in Help Center/ })).toHaveAttribute(
      'href',
      '/help/settings-overview',
    );
  });
});
