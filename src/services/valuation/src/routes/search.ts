import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { isOps, valuationScope } from '../auth/rbac.js';
import { searchUsers, searchValuations } from '../repos/search.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Global search (M4, P2 #32). One query box across valuations (company name,
 * number, exact id) and — for ops — users (name, email, id). Valuation hits
 * are scope-filtered in SQL like every list endpoint.
 */

const SearchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export function registerSearchRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/search', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = SearchQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const { q, limit } = parsed.data;

    const [valuations, users] = await Promise.all([
      searchValuations(deps.pool, valuationScope(principal), q, limit),
      isOps(principal) ? searchUsers(deps.pool, q, limit) : Promise.resolve([]),
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
      users,
    };
  });
}
