import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ContactPage } from '../src/pages/marketing/StaticPages';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderContact() {
  return render(
    <MemoryRouter>
      <ContactPage />
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('contact form (gap #28)', () => {
  it('submits the form fields to the public endpoint and shows a confirmation', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ submission: { id: '01J', created_at: '2026-07-10' } }, 201));

    renderContact();

    await user.type(screen.getByLabelText('Full name'), 'Ada Lovelace');
    await user.type(screen.getByLabelText('Email'), 'ada@analytical.example');
    await user.type(screen.getByLabelText('Company'), 'Analytical Engines');
    await user.type(
      screen.getByLabelText('Message'),
      'I need a 409A valuation before our next board meeting.',
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/contact');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@analytical.example',
      company: 'Analytical Engines',
      message: 'I need a 409A valuation before our next board meeting.',
    });

    expect(await screen.findByText('Thanks — your message is in.')).toBeInTheDocument();
  });

  it('keeps the submit button disabled until the required fields are filled', async () => {
    const user = userEvent.setup();
    renderContact();

    const button = screen.getByRole('button', { name: 'Send message' });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText('Full name'), 'Ada');
    await user.type(screen.getByLabelText('Email'), 'ada@x.example');
    await user.type(screen.getByLabelText('Message'), 'Hello');
    expect(button).toBeEnabled();
  });

  it('surfaces a server error without clearing the form', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ status: 429, title: 'Too Many Requests', detail: 'Slow down' }, 429),
    );
    renderContact();

    await user.type(screen.getByLabelText('Full name'), 'Ada');
    await user.type(screen.getByLabelText('Email'), 'ada@x.example');
    await user.type(screen.getByLabelText('Message'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Slow down');
    // Form is still there for a retry.
    expect(screen.getByLabelText('Full name')).toHaveValue('Ada');
  });
});
