import type { FastifyInstance } from 'fastify';

/**
 * `Cache-Control` on every response that is a file, stamped where the file is
 * sent rather than where each route remembers to.
 *
 * WHY THIS EXISTS (R349, methodology M4). Sixteen routes on this service answer
 * with a `content-disposition` header — an uploaded document, a 409A report, a
 * receipt, an invoice, the change log, the valuation exports, the model
 * workbook, a partner's copy of any of them. Two of them said anything at all
 * about caching, and both said the same thing for the same reason, which
 * `routes/account.ts` writes out in full: "a file of somebody's own personal
 * data has no business in a shared cache, and `no-store` is the one directive
 * that also keeps it out of the browser's disk cache on a machine they may not
 * own". That argument is not about personal-data exports. It is about every one
 * of the sixteen, and fourteen of them went out bare.
 *
 * Bare is not neutral here, because this deployment has a shared cache in front
 * of it. `n409.aiknol.com` is proxied through Cloudflare (see
 * `infra/caddy/n409.aiknol.com.caddy`, whose whole trusted-proxy block exists
 * because of it), and a proxy with no directive to obey falls back to its own
 * defaults — which for the standard configuration are keyed on the *extension
 * in the URL path*. Four of these downloads have one:
 *
 *   * `GET /api/v1/valuations/:id/report.pdf`
 *   * `GET /api/v1/valuations/:id/workbook.xlsx`
 *   * `GET /api/v1/valuations/:id/audit-trail.csv`
 *   * `GET /api/v1/valuations/:id/payments/:paymentId/receipt.pdf`
 *
 * `.pdf`, `.xlsx` and `.csv` are all on the default cacheable list. The session
 * lives in a cookie rather than an `Authorization` header, and nothing in these
 * responses sets one on the way back, so there is no signal in either direction
 * telling the edge that the body is one person's. The failure that produces is
 * the worst one this platform has: a concluded fair market value for a named
 * client, served from an edge cache to whoever asks for the same URL next.
 *
 * WHY A HOOK AND NOT FOURTEEN HEADERS. The same reason `trackedSweep` and
 * `storeDocument` exist: a rule applied at each call site is a rule the next
 * call site does not have. A download route is *identified* by the header it
 * already sets — `content-disposition` is what makes a response a file rather
 * than a payload — so the trigger and the concern are the same fact, and a
 * seventeenth download door gets the directive without its author knowing this
 * file is here.
 *
 * WHAT IT DOES NOT DO. It never overwrites a `cache-control` a route has
 * already set. `GET /api/v1/sample-report/pdf` is a marketing artefact with no
 * client in it and deliberately answers `public, max-age=3600`; that is a
 * decision, and this is a default. The two personal-data exports keep their own
 * `no-store` for the same reason — the sentence explaining why belongs next to
 * the export, not here.
 *
 * `private` beside `no-store` is redundant to a cache that implements RFC 9111
 * and is carried anyway: `no-store` is the newer, stronger directive and
 * `private` is the one an old intermediary is most likely to understand. The
 * cost of both is nine bytes.
 */
export const DOWNLOAD_CACHE_CONTROL = 'private, no-store';

export function registerDownloadCacheControl(app: FastifyInstance): void {
  app.addHook('onSend', (_req, reply, payload, done) => {
    if (
      reply.getHeader('content-disposition') !== undefined &&
      reply.getHeader('cache-control') === undefined
    ) {
      void reply.header('cache-control', DOWNLOAD_CACHE_CONTROL);
    }
    done(null, payload);
  });
}
