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
  fmv_per_share_cents: number | null;
  methodology: string | null;
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

      const { rows } = await pool.query<{
        valuation_id: string;
        expires_at: Date;
        company_name: string;
        valuation_date: string | null;
        fmv_per_share_cents: number | null;
        methodology: string | null;
        state: string;
        kind: string;
      }>(
        `SELECT
           st.valuation_id,
           st.expires_at,
           v.company_name,
           v.valuation_date,
           v.fmv_per_share_cents,
           v.methodology,
           v.state,
           v.kind
         FROM valuation_share_tokens st
         JOIN valuations v ON v.id = st.valuation_id
         WHERE st.token = $1`,
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

      await pool.query(
        `UPDATE valuation_share_tokens SET view_count = view_count + 1 WHERE token = $1`,
        [token],
      );

      const summary: ShareSummary = {
        company_name: row.company_name,
        valuation_date: row.valuation_date,
        fmv_per_share_cents: row.fmv_per_share_cents,
        methodology: row.methodology,
        state: row.state,
        kind: row.kind,
        powered_by: 'DoAide 409A',
      };

      return summary;
    },
  );
}
