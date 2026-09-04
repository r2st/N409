import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { conditionalJson, problems } from '@n409/shared';
import { canManageBranding, canManageUsers } from '../auth/rbac.js';
import {
  BRANDING_PATCH_SCHEMA,
  brandingCssVariables,
  PLATFORM_BRANDING,
  publicPartnerName,
  resolveBranding,
  type Branding,
} from '../domain/branding.js';
import { normalizeSubdomain, subdomainFromHost } from '../domain/partnerSubdomain.js';
import {
  findBrandingByPartnerId,
  invalidateBranding,
  loadBrandingByKey,
  loadBrandingByPartnerId,
  loadBrandingBySubdomain,
  publicPartnerNameSql,
  updateBranding,
} from '../repos/branding.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';
import { isUniqueViolation } from '../db/pgError.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { forbidden } from '../domain/accessProblem.js';
import { ulidField } from '../domain/ulidField.js';

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
   * The three resolved-branding reads are served through the read-through
   * cache in `repos/branding.ts`.
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
   * The cache moved to the repo when `PATCH /api/v1/partners/:id` turned out to
   * be a second writer of the same columns with no way to reach it — see
   * `invalidateBranding`. Nothing about the caching changed: 60s ceiling, one
   * tag per tenant, every write invalidating the tenant it wrote.
   */

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
    const source = await loadBrandingByKey(deps.pool, key);
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
    const source = await loadBrandingBySubdomain(deps.pool, label);
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
    const source = await loadBrandingByPartnerId(deps.pool, principal.partnerId);
    return conditionalJson(req, reply, respond(resolveBranding(source)));
  });

  /**
   * The editing view: the stored fields rather than the resolved ones, because
   * a form has to show which values are actually set versus inherited.
   */
  app.get('/api/v1/branding/settings', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const parsed = z.object({ partner_id: ulidField().optional() }).safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);

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
    const query = z.object({ partner_id: ulidField().optional() }).safeParse(req.query);
    if (!query.success) throw invalidQuery(query.error);

    // Ops act on a named tenant; a firm administrator acts on their own and may
    // not name one at all — passing someone else's id is a 403, not a silent
    // rewrite to their own.
    const partnerId = query.data.partner_id ?? principal.partnerId;
    if (!partnerId) throw problems.notFound('No tenant to brand');
    if (!canManageBranding(principal, partnerId))
      throw problems.forbidden('You cannot manage this tenant’s branding');

    const parsed = BRANDING_PATCH_SCHEMA.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid branding', parsed.error);
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

    // Invalidate this tenant, rather than every tenant.
    //
    // This was `cache.clear()`, for a reason that was sound and is now handled:
    // the three keys a tenant is cached under are `key:<slug>`,
    // `subdomain:<label>` and `partner:<id>`, and this very handler can *change*
    // the subdomain — so the entry to invalidate is filed under the label the
    // tenant had before the write, which is not in `patch`. Enumerating the keys
    // here would miss that one and leave the old address serving the old brand
    // for a full TTL, which is precisely the change the administrator is
    // watching for.
    //
    // The tag settles it without anyone enumerating anything. Every cached
    // branding entry is tagged with the partner it *resolved to* (see
    // `brandingTags`), whichever key it happens to be filed under and whatever
    // that key was called when it was written, so one tag drops all three — and
    // drops the fourth key shape too, the day somebody adds one.
    //
    // What clearing bought and this gives up is nothing, because clearing was
    // never buying correctness for the *other* tenants; it was paying for this
    // one's. Branding is the most-requested non-static endpoint here — the
    // signed-out SPA calls it before its first frame, on every load, on every
    // host — so a single firm editing its logo was dumping every other firm's
    // resolved brand and CSS ramps, and each of those tenants then re-queried on
    // its next request.
    //
    // Both halves are one call now that the cache lives in the repo, because
    // the ops console writes these columns too; `invalidateBranding` holds the
    // tag argument above and the by-key argument below in full.
    //
    // The tag cannot cover a `null`: a miss cached for a subdomain that
    // resolved to no tenant has no partner to be tagged with, and this handler
    // is exactly what makes such a miss wrong. Two writes do it — a firm
    // claiming `acme`, and a firm that already holds `acme` switching white
    // label *on*, since `findBrandingBySubdomain` only resolves tenants with the
    // flag set and cached a `null` for it until now. Either way the login page
    // at that address is what reads the lie.
    //
    // Keyed off the row rather than off `patch`, because the second case does
    // not mention a subdomain at all: flipping `white_label_enabled` alone
    // leaves `patch.subdomain` undefined while changing what that label
    // resolves to. `source` is the tenant after the write, so it carries the
    // label in both cases. The label the tenant had *before* a rename needs no
    // handling here — that entry resolved to this partner, so it is tagged, and
    // the invalidation above already dropped it.
    //
    // `key:<slug>` gets no equivalent because `partners.key` is not in
    // BRANDING_PATCH_SCHEMA: a slug is assigned when the partner is created and
    // this handler cannot change it, so no write here can turn a cached
    // `key:<slug> → null` into a lie.
    invalidateBranding(partnerId, { subdomain: source.subdomain });

    await recordAdminEvent(deps.pool, {
      type: 'branding_updated',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'partner',
      subjectId: partnerId,
      // The same rule again rather than `brand_name ?? name`, which named a
      // tenant in the activity log by a brand it had only staged — and, since
      // `??` passes whitespace through, could write an audit row whose subject
      // label was blank.
      subjectLabel: publicPartnerName(source),
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

  /**
   * Ops-only: which tenants have taken their brand live.
   *
   * `name` is the one rule, not a third spelling of it. This read used to say
   * `coalesce(brand_name, name)`, which differs from `publicPartnerNameSql` in
   * both halves and in the direction that misinforms the console:
   *
   *  - it ignores `white_label_enabled`, so a firm that had *staged* a brand
   *    name and not turned white label on was listed under that name with
   *    `enabled: false` beside it — on the screen whose entire question is
   *    which tenants have gone live, the name column answered it one way and
   *    the flag column the other; and
   *  - `coalesce` only catches NULL, while the column admits whitespace
   *    (`BRANDING_PATCH_SCHEMA` is `z.string().min(1)`, which `'   '` passes),
   *    so a tenant that saved a blank brand name appeared in the roster with
   *    no name at all.
   *
   * So `name` resolves through the shared rule — the same name this firm's own
   * clients read — and the staged value is reported beside it as itself, blank
   * normalised to null, rather than being folded into the name and losing the
   * distinction the console exists to show.
   */
  app.get('/api/v1/branding/tenants', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!canManageUsers(principal)) throw forbidden('Listing branded tenants', 'user-admin');
    const { rows } = await deps.pool.query<{
      id: string;
      name: string;
      brand_name: string | null;
      key: string;
      enabled: boolean;
    }>(
      `SELECT id,
              ${publicPartnerNameSql('partners')} AS name,
              nullif(btrim(brand_name), '') AS brand_name,
              key,
              white_label_enabled AS enabled
         FROM partners WHERE archived_at IS NULL ORDER BY white_label_enabled DESC, name ASC`,
    );
    return { tenants: rows };
  });
}
