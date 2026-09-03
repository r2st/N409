/**
 * Per-route request-body ceilings, where a route's schema declares a body
 * larger than the service's transport will carry.
 *
 * `buildApp` sets no `bodyLimit`, so every route on this service is bounded by
 * Fastify's default of 1 MiB. That is the right ceiling for the other ~430 of
 * them — a body over a megabyte is a mistake on an engagement patch or a
 * comment — but three routes declare, in their own zod schemas, a body several
 * times that size, and a schema that cannot be reached is not a contract:
 *
 * * `PUT /api/v1/valuations/:id/report` — `PutBody` is 50 sections of 100,000
 *   characters of HTML apiece. `reportScale.test.ts` builds exactly that body
 *   and asserts it renders, so it is not a theoretical maximum; it is the
 *   editor's stated ceiling. Measured: a 30-section report (3 MB, well inside
 *   the schema) was answered 413 before the handler ran.
 * * `PUT /api/v1/valuations/:id/cap-table` and its `…/preview` twin —
 *   `ImportBody.csv` is `z.string().max(2_000_000)`, twice the transport's.
 * * `POST /api/v1/report-templates` and its `PATCH` — a template body is
 *   `z.string().max(1_000_000)`, which with JSON escaping and the fields beside
 *   it crosses a megabyte before the schema has an opinion.
 *
 * The failure is quiet in the way that matters: the 413 is raised by the
 * content-type parser, so it names no field and quotes no limit. An analyst who
 * has spent an afternoon on a long report is told "Request body is too large"
 * about a body their editor believes is legal, with nothing to shorten it to.
 *
 * Set per route rather than on `Fastify({ … })`, deliberately. A service-wide
 * ceiling of 8 MiB would let every route buffer eight megabytes before its
 * schema — or its `preHandler` authentication — got a word in, which is a much
 * larger change than the three schemas this is written for.
 *
 * The numbers are byte ceilings over character limits, so they carry the
 * multi-byte and JSON-escaping headroom the schemas do not measure. They are
 * not second, tighter opinions about length: each is comfortably above what its
 * schema accepts, so the refusal a caller meets is the schema's, which names
 * the field.
 */

/**
 * `PUT /api/v1/valuations/:id/report`. 50 × 100,000 characters is 5 MB of
 * ASCII; 8 MiB is the same figure the report service's own `buildApp` uses for
 * the rendered payload this body becomes, so one number covers the wire in both
 * directions.
 */
export const REPORT_BODY_LIMIT = 8 * 1024 * 1024;

/** The cap-table import pair. `ImportBody.csv` is 2,000,000 characters. */
export const CAP_TABLE_IMPORT_BODY_LIMIT = 4 * 1024 * 1024;

/** The report-template pair. `body` is 1,000,000 characters. */
export const REPORT_TEMPLATE_BODY_LIMIT = 2 * 1024 * 1024;
