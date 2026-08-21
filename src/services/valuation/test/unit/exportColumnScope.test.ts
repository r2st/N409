import { describe, expect, it } from 'vitest';
import { exportColumnsVisibleTo } from '../../src/routes/exports.js';
import type { Principal } from '../../src/auth/rbac.js';

/**
 * Which columns an export projects, per reader.
 *
 * The integration test (`exportFieldScope`) proves the route withholds the
 * reviewer's address from a client's file. This pins the predicate underneath
 * it, over the roles the route never sees in one run — and over the two column
 * shapes, because the CSV list is strings and the XLSX list is objects, and a
 * filter that handled only one would leave the address in the spreadsheet while
 * the CSV looked fixed.
 */
const principal = (roles: string[]): Principal =>
  ({ id: 'u1', email: 'u@example.com', roles, partnerId: null }) as unknown as Principal;

const CSV_SHAPE = ['number', 'company_name', 'owner_email', 'reviewer_email'] as const;
const XLSX_SHAPE = [
  { key: 'number', header: 'Number' },
  { key: 'company_name', header: 'Company' },
  { key: 'owner_email', header: 'Owner' },
  { key: 'reviewer_email', header: 'Reviewer' },
];

describe('export column scope', () => {
  describe('ops keep the whole projection', () => {
    it.each([['admin'], ['god'], ['supervisor'], ['support'], ['reviewer']])(
      '%s sees reviewer_email',
      (role) => {
        expect(exportColumnsVisibleTo(CSV_SHAPE, principal([role]))).toContain('reviewer_email');
      },
    );

    it('returns a copy, not the caller’s array', () => {
      // The column lists are module-level constants shared by every request; a
      // filter that handed back the original would let one caller's mutation
      // reach the next.
      const out = exportColumnsVisibleTo(CSV_SHAPE, principal(['admin']));
      expect(out).not.toBe(CSV_SHAPE);
      expect(out).toEqual([...CSV_SHAPE]);
    });
  });

  describe('everyone else loses the internal columns', () => {
    it.each([['valuation_user'], ['partner'], ['member'], []])(
      'roles %j do not see reviewer_email',
      (...roles) => {
        const out = exportColumnsVisibleTo(CSV_SHAPE, principal(roles.flat() as string[]));
        expect(out).not.toContain('reviewer_email');
      },
    );

    it('keeps every column that is not internal', () => {
      expect(exportColumnsVisibleTo(CSV_SHAPE, principal(['valuation_user']))).toEqual([
        'number',
        'company_name',
        'owner_email',
      ]);
    });

    /**
     * `owner_email` deliberately survives. Inside a caller's own scope the owner
     * is themselves or their own client, so it tells the reader nothing their
     * row scope did not already — and dropping it would break the export for
     * the partner firms that reconcile against it.
     */
    it('does not withhold owner_email', () => {
      expect(exportColumnsVisibleTo(CSV_SHAPE, principal(['partner']))).toContain('owner_email');
    });
  });

  describe('the object-shaped column list is filtered on the same key', () => {
    it('drops the reviewer column from an XLSX projection', () => {
      const out = exportColumnsVisibleTo(XLSX_SHAPE, principal(['valuation_user']));
      expect(out.map((c) => c.key)).toEqual(['number', 'company_name', 'owner_email']);
    });

    it('leaves an ops XLSX projection whole', () => {
      const out = exportColumnsVisibleTo(XLSX_SHAPE, principal(['admin']));
      expect(out.map((c) => c.key)).toEqual(['number', 'company_name', 'owner_email', 'reviewer_email']);
    });
  });
});
