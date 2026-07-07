import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OverwritesSchemaPage } from '../src/pages/OverwritesSchemaPage';

const SCHEMA = {
  total: 3,
  categories: [
    { key: 'company_info', field_count: 2 },
    { key: 'valuation_params', field_count: 1 },
  ],
  fields: [
    {
      key: 'industry_id',
      category: 'company_info',
      class: 'numeric',
      label: 'Industry ID',
      description: 'Numeric industry classification.',
      min: 1,
      max: 9999,
      example: 7372,
    },
    {
      key: 'valuation_date',
      category: 'company_info',
      class: 'date',
      label: 'Valuation date',
      description: 'The as-of date.',
      example: '2026-06-30',
    },
    {
      key: 'dlom',
      category: 'valuation_params',
      class: 'numeric',
      label: 'DLOM',
      description: 'Discount for lack of marketability.',
      min: 0,
      max: 0.9,
      example: 0.28,
    },
  ],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('OverwritesSchemaPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders every field with class badge and range', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SCHEMA));
    render(<OverwritesSchemaPage />);

    expect(await screen.findByText('Industry ID')).toBeInTheDocument();
    expect(screen.getByText('Valuation date')).toBeInTheDocument();
    expect(screen.getByText('DLOM')).toBeInTheDocument();
    expect(screen.getAllByText('numeric')).toHaveLength(2);
    expect(screen.getByText('1 – 9999')).toBeInTheDocument();
    expect(screen.getByText(/The 3 fields an analyst can manually override/)).toBeInTheDocument();
  });

  it('filters by text and by category card', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SCHEMA));
    render(<OverwritesSchemaPage />);
    await screen.findByText('Industry ID');

    await userEvent.type(screen.getByLabelText('Filter fields'), 'dlom');
    expect(screen.queryByText('Industry ID')).not.toBeInTheDocument();
    expect(screen.getByText('DLOM')).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Filter fields'));
    await userEvent.click(screen.getByRole('button', { name: /Company Information/ }));
    expect(screen.getByText('Industry ID')).toBeInTheDocument();
    expect(screen.queryByText('DLOM')).not.toBeInTheDocument();
  });
});
