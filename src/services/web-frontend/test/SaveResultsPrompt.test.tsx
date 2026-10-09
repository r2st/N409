import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/lib/auth', () => ({
  useAuth: vi.fn(() => ({ status: 'anonymous', user: null })),
}));

import { useAuth } from '../src/lib/auth';
import { SaveResultsPrompt } from '../src/components/SaveResultsPrompt';

const mockUseAuth = vi.mocked(useAuth);

function renderPrompt(toolName = 'readiness check') {
  return render(
    <MemoryRouter>
      <SaveResultsPrompt toolName={toolName} />
    </MemoryRouter>,
  );
}

describe('SaveResultsPrompt', () => {
  it('renders for anonymous users', () => {
    mockUseAuth.mockReturnValue({ status: 'anonymous' } as ReturnType<typeof useAuth>);
    renderPrompt();
    expect(screen.getByTestId('save-results-prompt')).toBeTruthy();
    expect(screen.getByText(/Save your readiness check results/)).toBeTruthy();
  });

  it('shows Google SSO and email signup options', () => {
    mockUseAuth.mockReturnValue({ status: 'anonymous' } as ReturnType<typeof useAuth>);
    renderPrompt();
    expect(screen.getByTestId('sso-google')).toBeTruthy();
    expect(screen.getByTestId('signup-email')).toBeTruthy();
  });

  it('does not render for authenticated users', () => {
    mockUseAuth.mockReturnValue({ status: 'authenticated', user: { id: 'u1' } } as ReturnType<typeof useAuth>);
    renderPrompt();
    expect(screen.queryByTestId('save-results-prompt')).toBeNull();
  });

  it('can be dismissed', async () => {
    mockUseAuth.mockReturnValue({ status: 'anonymous' } as ReturnType<typeof useAuth>);
    const user = userEvent.setup();
    renderPrompt();

    expect(screen.getByTestId('save-results-prompt')).toBeTruthy();
    await user.click(screen.getByTestId('dismiss-prompt'));
    expect(screen.queryByTestId('save-results-prompt')).toBeNull();
  });

  it('uses the toolName prop in the heading', () => {
    mockUseAuth.mockReturnValue({ status: 'anonymous' } as ReturnType<typeof useAuth>);
    renderPrompt('valuation estimate');
    expect(screen.getByText(/Save your valuation estimate results/)).toBeTruthy();
  });

  it('Google SSO links to the auth endpoint', () => {
    mockUseAuth.mockReturnValue({ status: 'anonymous' } as ReturnType<typeof useAuth>);
    renderPrompt();
    const googleLink = screen.getByTestId('sso-google');
    expect(googleLink.getAttribute('href')).toBe('/api/v1/auth/google');
  });

  it('email signup links to the register page', () => {
    mockUseAuth.mockReturnValue({ status: 'anonymous' } as ReturnType<typeof useAuth>);
    renderPrompt();
    const emailLink = screen.getByTestId('signup-email');
    expect(emailLink.getAttribute('href')).toBe('/register');
  });

  it('does not block access to tool functionality', () => {
    mockUseAuth.mockReturnValue({ status: 'anonymous' } as ReturnType<typeof useAuth>);
    renderPrompt();
    const prompt = screen.getByTestId('save-results-prompt');
    expect(prompt.querySelector('dialog')).toBeNull();
    expect(prompt.querySelector('[role="dialog"]')).toBeNull();
  });
});
