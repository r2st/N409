import { describe, it, expect } from 'vitest';
import { mapEmployees } from '../../src/clients/hris.js';

describe('HRIS roster + grant mapping (feature 11)', () => {
  it('flattens employees into a roster and their equity grants', () => {
    const { roster, grants } = mapEmployees({
      companyName: 'Acme',
      employees: [
        {
          id: 'e1',
          firstName: 'Ada',
          lastName: 'Lovelace',
          workEmail: 'ada@acme.com',
          jobTitle: 'Engineer',
          equityGrants: [
            {
              id: 'g1',
              optionsGranted: 10000,
              strikePrice: 1.25,
              grantDate: '2025-03-01',
              vesting: { startDate: '2025-03-01', months: 48, cliffMonths: 12, frequencyMonths: 1 },
            },
          ],
        },
        { id: 'e2', fullName: 'No Grants', email: 'ng@acme.com' },
      ],
    });

    expect(roster).toHaveLength(2);
    expect(roster[0]).toMatchObject({ name: 'Ada Lovelace', email: 'ada@acme.com', title: 'Engineer' });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      external_id: 'g1',
      grantee_name: 'Ada Lovelace',
      grantee_email: 'ada@acme.com',
      grant_date: '2025-03-01',
      options_count: 10000,
      exercise_price: 1.25,
      vesting_months: 48,
      cliff_months: 12,
      frequency_months: 1,
    });
  });

  it('applies default vesting terms when the provider omits them', () => {
    const { grants } = mapEmployees({
      people: [
        { id: 'p1', name: 'Bob', grants: [{ grantId: 'gx', shares: 500, issueDate: '2026-01-15' }] },
      ],
    });
    expect(grants[0]).toMatchObject({
      external_id: 'gx',
      options_count: 500,
      exercise_price: 0,
      vesting_start_date: '2026-01-15',
      vesting_months: 48,
      cliff_months: 12,
      frequency_months: 1,
    });
  });

  it('drops grants missing an id, date, or a positive option count', () => {
    const { grants } = mapEmployees({
      employees: [
        {
          id: 'e',
          name: 'X',
          equityGrants: [
            { optionsGranted: 100, grantDate: '2025-01-01' }, // no id → dropped
            { id: 'g', optionsGranted: 0, grantDate: '2025-01-01' }, // zero → dropped
            { id: 'g2', optionsGranted: 100 }, // no date → dropped
          ],
        },
      ],
    });
    expect(grants).toHaveLength(0);
  });
});
