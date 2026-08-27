import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { isOps, valuationScope } from '../auth/rbac.js';
import { searchDocuments, searchUsers, searchValuations } from '../repos/search.js';
import { requirePrincipal } from '../plugins/auth.js';
import { invalidQuery } from '../domain/validationProblem.js';

/**
 * Global search (M4, P2 #32). One query box across valuations (company name,
 * number, exact id), documents (filename, exact id) and — for ops — users
 * (name, email, id). Valuation and document hits are scope-filtered in SQL
 * like every list endpoint.
 *
 * `type` narrows the search to one collection. The page requests everything by
 * default, but the three queries are independent, so a caller that only wants
 * documents should not pay for the other two.
 */

const SEARCH_TYPES = ['valuations', 'documents', 'users'] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

const SearchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  type: z.enum(SEARCH_TYPES).optional(),
});

export function registerSearchRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/search', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = SearchQuery.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const { q, limit, type } = parsed.data;
    const scope = valuationScope(principal);
    const wants = (t: SearchType) => type === undefined || type === t;

    const [valuations, documents, users] = await Promise.all([
      wants('valuations') ? searchValuations(deps.pool, scope, q, limit) : Promise.resolve([]),
      wants('documents') ? searchDocuments(deps.pool, scope, q, limit) : Promise.resolve([]),
      wants('users') && isOps(principal) ? searchUsers(deps.pool, q, limit) : Promise.resolve([]),
    ]);
    return {
      valuations: valuations.map((v) => ({
        id: v.id,
        number: v.number,
        kind: v.kind,
        state: v.state,
        company_name: v.company_name,
        service_name: v.service_name,
        created_at: v.created_at,
      })),
      documents,
      users,
    };
  });
}
