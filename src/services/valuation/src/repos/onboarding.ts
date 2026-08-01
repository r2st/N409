import type pg from 'pg';
import { buildValuationWhere } from './valuations.js';
import type { ValuationScope } from '../auth/rbac.js';
import { EMPTY_FACTS, type OnboardingFacts } from '../domain/onboarding.js';

/**
 * One round trip for the whole dashboard checklist.
 *
 * Every count is restricted to the valuations the caller may see, by reusing
 * the same `buildValuationWhere` the worklist uses — scope is enforced in SQL,
 * so a client can never learn that another tenant has uploaded a cap table.
 */
export async function onboardingFacts(pool: pg.Pool, scope: ValuationScope): Promise<OnboardingFacts> {
  if (scope.kind === 'none') return EMPTY_FACTS;
  const { whereSql, params } = buildValuationWhere(scope, {});

  const { rows } = await pool.query<Record<keyof OnboardingFacts, string>>(
    `WITH scoped AS (SELECT id FROM valuations ${whereSql})
     SELECT
       (SELECT count(*) FROM scoped) AS "valuations",
       (SELECT count(*) FROM cap_tables c JOIN scoped s ON s.id = c.valuation_id
          WHERE jsonb_typeof(c.entries) = 'array' AND jsonb_array_length(c.entries) > 0)
         AS "capTables",
       (SELECT count(*) FROM documents d JOIN scoped s ON s.id = d.valuation_id
          WHERE d.deleted_at IS NULL) AS "documents",
       (SELECT count(*) FROM valuation_params p JOIN scoped s ON s.id = p.valuation_id
          WHERE p.weight_asset IS NOT NULL OR p.weight_opm IS NOT NULL
             OR p.weight_income IS NOT NULL OR p.weight_market IS NOT NULL
             OR p.market_method IS NOT NULL) AS "methodology",
       (SELECT count(*) FROM valuation_params p JOIN scoped s ON s.id = p.valuation_id
          WHERE p.dlom IS NOT NULL OR p.dloc IS NOT NULL) AS "assumptions",
       (SELECT count(*) FROM calculations c JOIN scoped s ON s.id = c.valuation_id
          WHERE c.status = 'succeeded') AS "calculations",
       (SELECT count(*) FROM reports r JOIN scoped s ON s.id = r.valuation_id
          WHERE r.current_version > 0) AS "reports",
       (SELECT count(*) FROM board_signoffs b JOIN scoped s ON s.id = b.valuation_id
          WHERE b.status = 'signed') AS "boardSignoffs"`,
    params,
  );

  const row = rows[0];
  if (!row) return EMPTY_FACTS;
  // count() comes back as a bigint string; Number keeps the shape the domain
  // expects and a malformed value degrades to 0 rather than NaN-ing a box on.
  const toCount = (value: string | undefined): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    valuations: toCount(row.valuations),
    capTables: toCount(row.capTables),
    documents: toCount(row.documents),
    methodology: toCount(row.methodology),
    assumptions: toCount(row.assumptions),
    calculations: toCount(row.calculations),
    reports: toCount(row.reports),
    boardSignoffs: toCount(row.boardSignoffs),
  };
}
