import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminSettingsPage } from '../src/pages/AdminSettingsPage';
import type { SystemSettings, SystemSettingsResponse } from '../src/lib/types';

/** Runtime system settings: ops read, administrators write. */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const DEFAULTS: SystemSettings = {
  registration_enabled: true,
  maintenance_mode: false,
  password_min_length: 10,
  support_email: 'support@409.ai',
  default_delivery_days: 10,
};

interface Call {
  path: string;
  method: string;
  body?: Record<string, unknown>;
}

function mockApi(response: Partial<SystemSettingsResponse> = {}, putStatus = 200) {
  const calls: Call[] = [];
  const payload: SystemSettingsResponse = {
    settings: DEFAULTS,
    defaults: DEFAULTS,
    updated: {},
    editable: true,
    ...response,
  };

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, method, body });

    if (method === 'GET') return jsonResponse(payload);
    if (method === 'PUT') {
      if (putStatus !== 200) return jsonResponse({ status: putStatus, detail: 'Not allowed' }, putStatus);
      return jsonResponse({ settings: { ...payload.settings, ...body } });
    }
    throw new Error(`unexpected fetch ${method} ${path}`);
  });
  return calls;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminSettingsPage />
    </MemoryRouter>,
  );

const settled = () =>
  waitFor(() => expect(screen.getByText('System settings')).toBeInTheDocument());

describe('AdminSettingsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders current values and marks untouched keys as defaults', async () => {
    mockApi();
    renderPage();
    await settled();

    expect(screen.getByLabelText('Self-service registration')).toBeChecked();
    expect(screen.getByLabelText('Maintenance mode')).not.toBeChecked();
    expect(screen.getByLabelText(/^Minimum password length/)).toHaveValue(10);
    expect(screen.getAllByText('Default (true)').length).toBeGreaterThan(0);
  });

  it('shows when a value was changed rather than calling it a default', async () => {
    mockApi({
      settings: { ...DEFAULTS, maintenance_mode: true },
      updated: { maintenance_mode: { updated_at: '2026-07-01T10:00:00Z', updated_by: 'u1' } },
    });
    renderPage();
    await settled();

    expect(screen.getByLabelText('Maintenance mode')).toBeChecked();
    expect(screen.getByText(/^Changed /)).toBeInTheDocument();
  });

  it('sends only the keys that actually changed', async () => {
    const calls = mockApi();
    renderPage();
    await settled();

    await userEvent.click(screen.getByLabelText('Maintenance mode'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('System settings updated.');
    const put = calls.find((c) => c.method === 'PUT');
    // A full-object PUT would clobber a knob another admin just changed.
    expect(put?.body).toEqual({ maintenance_mode: true });
  });

  it('keeps Save disabled until something changes, and can discard', async () => {
    mockApi();
    renderPage();
    await settled();

    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByLabelText('Maintenance mode'));
    expect(save).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: /Discard 1 change/ }));
    expect(screen.getByLabelText('Maintenance mode')).not.toBeChecked();
    expect(save).toBeDisabled();
  });

  it('counts multiple pending changes', async () => {
    mockApi();
    renderPage();
    await settled();

    await userEvent.click(screen.getByLabelText('Maintenance mode'));
    await userEvent.click(screen.getByLabelText('Self-service registration'));
    expect(screen.getByRole('button', { name: /Discard 2 changes/ })).toBeInTheDocument();
  });

  it('is read-only for an ops user who cannot manage users', async () => {
    mockApi({ editable: false });
    renderPage();
    await settled();

    expect(screen.getByText(/only administrators can change these/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Maintenance mode')).toBeDisabled();
    expect(screen.getByLabelText(/^Minimum password length/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('surfaces a rejected write', async () => {
    mockApi({}, 403);
    renderPage();
    await settled();

    await userEvent.click(screen.getByLabelText('Maintenance mode'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
    expect(screen.queryByText('System settings updated.')).not.toBeInTheDocument();
  });

  it('surfaces a failed load', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ status: 403, detail: 'System settings are operations-only' }, 403),
    );
    renderPage();
    expect(await screen.findByText('System settings are operations-only')).toBeInTheDocument();
  });
});
