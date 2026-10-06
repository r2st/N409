import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EmailSubscribe } from '../src/components/EmailSubscribe';

vi.mock('../src/lib/api', () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    problem: { title: string };
    constructor(status: number, problem: { title: string }) {
      super(problem.title);
      this.status = status;
      this.problem = problem;
    }
  },
}));

const { api: mockApi } = await import('../src/lib/api');

beforeEach(() => {
  vi.mocked(mockApi).mockReset();
});

describe('EmailSubscribe', () => {
  it('renders a form with email input and subscribe button', () => {
    render(
      <MemoryRouter>
        <EmailSubscribe />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(/compliance deadlines/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /subscribe/i })).toBeInTheDocument();
  });

  it('shows success message after submission', async () => {
    vi.mocked(mockApi).mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <EmailSubscribe />
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText(/compliance deadlines/i), 'test@example.com');
    await user.click(screen.getByRole('button', { name: /subscribe/i }));
    await waitFor(() => {
      expect(screen.getByText(/you're subscribed/i)).toBeInTheDocument();
    });
  });

  it('shows error message on API failure', async () => {
    const { ApiError } = await import('../src/lib/api');
    vi.mocked(mockApi).mockRejectedValueOnce(new ApiError(429, { title: 'Too many requests' }));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <EmailSubscribe />
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText(/compliance deadlines/i), 'test@example.com');
    await user.click(screen.getByRole('button', { name: /subscribe/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/too many requests/i);
    });
  });
});
