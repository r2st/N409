import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { ApiProblem, isUlid, problems } from '@n409/shared';
import { requirePrincipal } from '../plugins/auth.js';
import { canReadValuation } from '../auth/rbac.js';
import type { ValuationRow } from '../repos/valuations.js';
import { findValuationById } from '../repos/valuations.js';
import { forbidden } from '../domain/accessProblem.js';
import { invalidBody } from '../domain/validationProblem.js';

const CreateShareBody = z.object({
  valuation_id: z.string().refine(isUlid, 'must be a ULID'),
});

function toRef(v: ValuationRow) {
  return { userId: v.user_id, partnerId: v.partner_id };
}

interface ShareSummary {
  company_name: string;
  valuation_date: string | null;
  fmv_per_share: number | null;
  currency: string;
  state: string;
  kind: string;
  powered_by: string;
}

export function registerShareTokenRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post<{ Body: z.infer<typeof CreateShareBody> }>(
    '/api/share-tokens',
    async (req) => {
      const principal = requirePrincipal(req);
      const parsed = CreateShareBody.safeParse(req.body);
      if (!parsed.success) throw invalidBody('Invalid share token request', parsed.error);

      const { valuation_id } = parsed.data;
      const valuation = await findValuationById(pool, valuation_id);
      if (!valuation) throw problems.notFound('valuation');
      if (!canReadValuation(principal, toRef(valuation)))
        throw forbidden('Creating a share link', 'own-record');

      const { rows } = await pool.query<{ token: string }>(
        `INSERT INTO valuation_share_tokens (valuation_id, created_by)
         VALUES ($1, $2)
         RETURNING token`,
        [valuation_id, principal.id],
      );

      return { token: rows[0]!.token };
    },
  );

  app.get<{ Params: { token: string } }>(
    '/api/share-tokens/:token/summary',
    async (req) => {
      const { token } = req.params;

      // Single round trip: bump view_count and return the joined row (R394 M8).
      // valuation_date lives in valuation_params.engine_inputs (JSONB), and
      // fmv_per_share is on the latest calculations row — scalar subqueries
      // avoid a second round trip for each.
      const { rows } = await pool.query<{
        valuation_id: string;
        expires_at: Date;
        company_name: string;
        valuation_date: string | null;
        fmv_per_share: string | null;
        currency: string;
        state: string;
        kind: string;
      }>(
        `WITH bumped AS (
           UPDATE valuation_share_tokens
              SET view_count = view_count + 1
            WHERE token = $1
           RETURNING valuation_id, expires_at
         )
         SELECT
           b.valuation_id,
           b.expires_at,
           v.company_name,
           (p.engine_inputs->>'valuation_date')::text AS valuation_date,
           (SELECT c.fmv_per_share::text
              FROM calculations c
             WHERE c.valuation_id = v.id AND c.status = 'completed'
             ORDER BY c.created_at DESC LIMIT 1) AS fmv_per_share,
           v.currency,
           v.state,
           v.kind
         FROM bumped b
         JOIN valuations v ON v.id = b.valuation_id
         LEFT JOIN valuation_params p ON p.valuation_id = v.id`,
        [token],
      );

      if (rows.length === 0) throw problems.notFound('share token');
      const row = rows[0]!;

      if (row.expires_at < new Date()) {
        throw new ApiProblem({
          status: 410,
          title: 'Gone',
          type: 'urn:n409:problem:gone',
          detail: 'This share link has expired',
        });
      }

      const summary: ShareSummary = {
        company_name: row.company_name,
        valuation_date: row.valuation_date ? row.valuation_date.slice(0, 10) : null,
        fmv_per_share: row.fmv_per_share !== null ? Number(row.fmv_per_share) : null,
        currency: row.currency ?? 'USD',
        state: row.state,
        kind: row.kind,
        powered_by: 'DoAide 409A',
      };

      return summary;
    },
  );
}
