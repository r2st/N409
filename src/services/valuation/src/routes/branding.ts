import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { conditionalJson, problems, TtlCache } from '@n409/shared';
import { canManageBranding, canManageUsers } from '../auth/rbac.js';
import {
  BRANDING_PATCH_SCHEMA,
  brandingCssVariables,
  PLATFORM_BRANDING,
  resolveBranding,
  type Branding,
} from '../domain/branding.js';
import { normalizeSubdomain, subdomainFromHost } from '../domain/partnerSubdomain.js';
import {
  findBrandingByKey,
  findBrandingByPartnerId,
  findBrandingBySubdomain,
  updateBranding,
} from '../repos/branding.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';
import { isUniqueViolation } from '../db/pgError.js';

/**
 * White-label branding (migration 0091).
 *
 * Three surfaces, one resolver:
 *  - `/public/branding/:key` — the signed-out login page, before any session.
 *  - `/branding` — the signed-in SPA, resolved from the caller's own tenant.
 *  - `PATCH /branding` — the firm administering its own identity.
 *
 * Every response is a fully-resolved `Branding`, never the raw row: clients
 * must not be reimplementing the fallback chain, because three clients
 * reimplementing it is three subtly different brands.
 */
export function registerBrandingRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; baseDomain?: string },
): void {
  /**
   * The resolved brand plus the CSS ramp for both theme modes. The client
   * applies `css` verbatim — no colour maths in the browser, so a tenant's
   * accent cannot come out one shade in the app and another in the report.
   */
  const respond = (branding: Branding) => ({
    branding,
    css: {
      light: brandingCssVariables(branding, 'light'),
      dark: brandingCssVariables(branding, 'dark'),
    },
  });

  /**
   * Read-through cache for the three resolved-branding reads.
   *
   * These are the most-requested endpoints on the platform that are not static
   * assets, and the docstrings above say why: the signed-out SPA calls
   * `/public/branding` before its first frame, on every load, on every host;
   * the signed-in SPA calls `/branding` "unconditionally on every load". Both
   * answer from a table that changes when a firm administrator edits their
   * logo — a few times a year per tenant.
   *
   * Each response also carries `css`, two fully-expanded variable ramps, which
   * makes this one of the larger routine payloads here. So both halves are
   * worth having and they save different things: the cache stops the query, and
   * the ETag below stops the transmission.
   *
   * 60s matches the blog's, and the TTL is the *ceiling* on staleness rather
   * than the mechanism — every write clears the cache outright (see PATCH).
   */
  const cache = new TtlCache<unknown>({ ttlMs: 60_000 });

  /**
   * `public` for the two anonymous reads: the response depends on the request
   * URI and nothing else, so a shared cache may hold it. That is true of the
   * host-derived route too — a cache key is the effective URI, which includes
   * the host, so the per-tenant variation is already in it.
   *
   * `no-cache` rather than a max-age, for the reason the blog gives: an
   * administrator who fixes their logo expects it live on the next request, and
   * revalidation costs one conditional round trip instead of a re-download.
   */
  const PUBLIC_REVALIDATE = { cacheControl: 'public, no-cache' };

  /**
   * Public by necessity — a firm's login page is branded before anyone has
   * signed in. Exposes only what that page renders, and nothing about who or
   * how many people are inside the tenant.
   */
  app.get('/api/v1/public/branding/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!/^[a-z0-9-]{1,100}$/.test(key)) throw problems.notFound();
    // The miss is cached too (as null), so a scan for tenant slugs that do not
    // exist does not turn into a query per 404 — the same reasoning the blog
    // applies to unknown post slugs, and this route is anonymous as well.
    const source = (await cache.getOrLoad(
      `key:${key}`,
      async () => (await findBrandingByKey(deps.pool, key)) ?? null,
    )) as Awaited<ReturnType<typeof findBrandingByKey>> | null;
    if (!source) throw problems.notFound();
    return conditionalJson(req, reply, respond(resolveBranding(source)), PUBLIC_REVALIDATE);
  });

  /**
   * Branding for whichever host the client actually arrived on (migration
   * 0106). This is what a white-label firm's own address serves, and it is the
   * only branding endpoint the signed-out SPA needs to know about — it does not
   * have to learn a slug from somewhere before it can render its first frame.
   *
   * Never 404s. A host with no tenant behind it — the platform's own address, a
   * reserved label, an unclaimed subdomain, a Host header someone made up — is
   * the platform, and the login page has to render on all of them.
   */
  app.get('/api/v1/public/branding', async (req, reply) => {
    const label = deps.baseDomain ? subdomainFromHost(req.headers.host, deps.baseDomain) : null;
    if (!label) return conditionalJson(req, reply, respond(PLATFORM_BRANDING), PUBLIC_REVALIDATE);
    // Keyed by the resolved label rather than by the raw Host: several hosts
    // reduce to one tenant, and caching per Host would hold a copy for each
    // while inventing a new key for every made-up Host header sent at us.
    const source = (await cache.getOrLoad('subdomain:' + label, async () =>
      findBrandingBySubdomain(deps.pool, label),
    )) as Awaited<ReturnType<typeof findBrandingBySubdomain>>;
    return conditionalJson(req, reply, respond(resolveBranding(source)), PUBLIC_REVALIDATE);
  });

  /**
   * The signed-in tenant's brand. A principal with no partner — direct clients
   * and platform staff — gets platform branding rather than a 404, so the SPA
   * can call this unconditionally on every load.
   */
  app.get('/api/v1/branding', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    // No cacheControl override: `conditionalJson` defaults to `private`, which
    // is the only correct answer here. The response is chosen by the caller's
    // own tenant rather than by the URI, so a shared cache holding it would
    // serve one firm's brand to another's staff.
    if (!principal.partnerId) return conditionalJson(req, reply, respond(PLATFORM_BRANDING));
    const source = (await cache.getOrLoad(`partner:${principal.partnerId}`, async () =>
      findBrandingByPartnerId(deps.pool, principal.partnerId!),
    )) as Awaited<ReturnType<typeof findBrandingByPartnerId>>;
    return conditionalJson(req, reply, respond(resolveBranding(source)));
  });

  /**
   * The editing view: the stored fields rather than the resolved ones, because
   * a form has to show which values are actually set versus inherited.
   */
  app.get('/api/v1/branding/settings', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = z.object({ partner_id: z.string().optional() }).safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query');

    const partnerId = parsed.data.partner_id ?? principal.partnerId;
    if (!partnerId) throw problems.notFound('No tenant to brand');
    if (!canManageBranding(principal, partnerId))
      throw problems.forbidden('You cannot manage this tenant’s branding');

    const source = await findBrandingByPartnerId(deps.pool, partnerId);
    if (!source) throw problems.notFound();
    return {
      settings: source,
      preview: resolveBranding({ ...source, white_label_enabled: true }),
      defaults: PLATFORM_BRANDING,
    };
  });

  app.patch('/api/v1/branding', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const query = z.object({ partner_id: z.string().optional() }).safeParse(req.query);
    if (!query.success) throw problems.badRequest('Invalid query');

    // Ops act on a named tenant; a firm administrator acts on their own and may
    // not name one at all — passing someone else's id is a 403, not a silent
    // rewrite to their own.
    const partnerId = query.data.partner_id ?? principal.partnerId;
    if (!partnerId) throw problems.notFound('No tenant to brand');
    if (!canManageBranding(principal, partnerId))
      throw problems.forbidden('You cannot manage this tenant’s branding');

    const parsed = BRANDING_PATCH_SCHEMA.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid branding', { errors: parsed.error.issues });
    if (Object.keys(parsed.data).length === 0) throw problems.unprocessable('No branding to update');

    // The schema checks the shape; this checks that the name is one we are
    // willing to hand out. Reserved labels are the load-bearing half — a tenant
    // holding `secure` or `login` under our domain is a phishing page with our
    // certificate on it, and self-service registration is how it would happen.
    const patch = { ...parsed.data };
    if (patch.subdomain != null) {
      const normalized = normalizeSubdomain(patch.subdomain);
      if ('problem' in normalized) {
        throw problems.unprocessable(
          normalized.problem === 'reserved'
            ? `"${patch.subdomain}" is reserved and cannot be used as a subdomain`
            : 'A subdomain must be 3–63 characters of a–z, 0–9 and hyphens, not starting or ending with one',
        );
      }
      patch.subdomain = normalized.subdomain;
    }

    let source: Awaited<ReturnType<typeof updateBranding>>;
    try {
      source = await updateBranding(deps.pool, partnerId, patch);
    } catch (err) {
      // partners_subdomain_key. Two firms cannot share an address, and the
      // race between "is it free?" and "take it" is real enough that the
      // unique index has to be what answers, not a prior SELECT.
      if (isUniqueViolation(err, 'partners_subdomain_key')) {
        throw problems.conflict(`The subdomain "${patch.subdomain}" is already taken`);
      }
      throw err;
    }
    if (!source) throw problems.notFound();

    // Clear everything rather than the three keys this partner is behind.
    //
    // Those keys are `key:<slug>`, `subdomain:<label>` and `partner:<id>`, and
    // this very handler can *change* the subdomain — so the entry to invalidate
    // is filed under the label the tenant had before the write, which is not in
    // `patch` and would have to be read back to be known. A partial
    // invalidation that misses that one leaves the old address serving the old
    // brand for a full TTL, which is precisely the change the administrator was
    // watching for. Branding writes are an administrator action a few times a
    // year; the cost of clearing the whole (small) cache is one re-query per
    // live tenant, and the correctness is not conditional on anybody enumerating
    // the key shapes correctly next time one is added.
    cache.clear();

    await recordAdminEvent(deps.pool, {
      type: 'branding_updated',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'partner',
      subjectId: partnerId,
      subjectLabel: source.brand_name ?? source.name,
      payload: {
        fields: Object.keys(parsed.data),
        white_label_enabled: source.white_label_enabled,
        // Branding changes what every client of this firm sees, so the audit
        // trail carries the values, not just the field names.
        applied: parsed.data,
      },
    });

    return { settings: source, branding: resolveBranding(source) };
  });

  /** Ops-only: which tenants have taken their brand live. */
  app.get('/api/v1/branding/tenants', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal)) throw problems.forbidden();
    const { rows } = await deps.pool.query<{ id: string; name: string; key: string; enabled: boolean }>(
      `SELECT id, coalesce(brand_name, name) AS name, key, white_label_enabled AS enabled
         FROM partners WHERE archived_at IS NULL ORDER BY white_label_enabled DESC, name ASC`,
    );
    return { tenants: rows };
  });
}
