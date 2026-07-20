import { describe, it, expect } from 'vitest';
import { mapCarta, mapPulley } from '../../src/clients/capTableSync.js';
import { diffCapTables } from '../../src/domain/capTableSync.js';
import type { CapTableEntry } from '../../src/domain/capTable.js';

describe('provider cap-table mapping', () => {
  it('maps a Carta payload including options, warrants and convertibles', () => {
    const entries = mapCarta({
      shareClasses: [
        { name: 'Common', type: 'common', outstandingShares: 8_000_000, issuePrice: 0.001 },
        {
          name: 'Series A',
          type: 'preferred',
          outstandingShares: 2_000_000,
          issuePrice: 1.5,
          amountInvested: 3_000_000,
          liquidationPreference: 1,
          seniority: 1,
          conversionRatio: 1,
        },
      ],
      optionPools: [{ name: 'Option Pool', outstandingShares: 1_000_000, strikePrice: 0.5 }],
      warrants: [{ name: 'Warrants', shares: 100_000, strikePrice: 1 }],
      convertibles: [{ name: 'SAFE 2023', principal: 500_000, liquidationMultiple: 1 }],
    });
    const byName = Object.fromEntries(entries.map((e) => [e.security_class, e]));
    expect(byName['Common']!.class_type).toBe('common');
    expect(byName['Common']!.shares).toBe(8_000_000);
    expect(byName['Series A']!.class_type).toBe('preferred');
    expect(byName['Series A']!.invested_amount).toBe(3_000_000);
    expect(byName['Option Pool']!.class_type).toBe('option');
    expect(byName['Warrants']!.class_type).toBe('warrant');
    // Convertible note becomes a preference-bearing preferred row.
    expect(byName['SAFE 2023']!.class_type).toBe('preferred');
    expect(byName['SAFE 2023']!.invested_amount).toBe(500_000);
    expect(byName['SAFE 2023']!.liquidation_multiple).toBe(1);
  });

  it('maps a Pulley payload with securities + convertibles', () => {
    const entries = mapPulley({
      securities: [
        { shareClass: 'Common', securityType: 'common', sharesOutstanding: 5_000_000 },
        {
          shareClass: 'Seed Preferred',
          securityType: 'preferred',
          sharesOutstanding: 1_500_000,
          totalInvested: 2_000_000,
          liquidationMultiple: 1,
        },
        { shareClass: 'ESOP', securityType: 'option', sharesOutstanding: 750_000 },
      ],
      convertibles: [{ name: 'Note 2024', principal: 250_000 }],
    });
    const byName = Object.fromEntries(entries.map((e) => [e.security_class, e]));
    expect(byName['Common']!.shares).toBe(5_000_000);
    expect(byName['Seed Preferred']!.invested_amount).toBe(2_000_000);
    expect(byName['ESOP']!.class_type).toBe('option');
    expect(byName['Note 2024']!.class_type).toBe('preferred');
  });
});

const entry = (over: Partial<CapTableEntry> & { security_class: string }): CapTableEntry => ({
  security_class: over.security_class,
  class_type: over.class_type ?? 'common',
  shares: over.shares ?? 0,
  price_per_share: over.price_per_share ?? null,
  invested_amount: over.invested_amount ?? null,
  liquidation_multiple: over.liquidation_multiple ?? null,
  seniority: over.seniority ?? null,
  conversion_ratio: over.conversion_ratio ?? null,
});

describe('cap-table diff', () => {
  it('reports no conflicts for identical tables', () => {
    const a = [entry({ security_class: 'Common', shares: 1000 })];
    const diff = diffCapTables(a, [entry({ security_class: 'Common', shares: 1000 })]);
    expect(diff.has_conflicts).toBe(false);
  });

  it('detects changed, added and removed classes', () => {
    const existing = [
      entry({ security_class: 'Common', shares: 1000 }),
      entry({ security_class: 'Series A', class_type: 'preferred', shares: 500 }),
    ];
    const incoming = [
      entry({ security_class: 'Common', shares: 1200 }), // changed
      entry({ security_class: 'Series B', class_type: 'preferred', shares: 300 }), // added
      // Series A removed
    ];
    const diff = diffCapTables(existing, incoming);
    expect(diff.changed).toBe(1);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    const common = diff.conflicts.find((c) => c.security_class === 'Common')!;
    expect(common.status).toBe('changed');
    expect(common.changes).toContainEqual({ field: 'shares', from: 1000, to: 1200 });
  });

  it('matches class names case-insensitively', () => {
    const diff = diffCapTables(
      [entry({ security_class: 'common', shares: 1000 })],
      [entry({ security_class: 'Common', shares: 1000 })],
    );
    expect(diff.has_conflicts).toBe(false);
  });
});
