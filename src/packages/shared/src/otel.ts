import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
// `resourceFromAttributes` rather than `new Resource(...)`: the class became a
// type-only export in @opentelemetry/resources 2.x, which is the version the
// round-74 dependency bump moved to (GHSA-q7rr-3cgh-j5r3 and two others). Same
// object, built by a factory.
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
// Metric packages are hard dependencies of @opentelemetry/sdk-node (already a
// direct dependency), so importing them transitively is version-safe.
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { SENSITIVE_QUERY_PARAMS, scrubUrl } from './problem.js';

/**
 * The query parameters the HTTP instrumentation redacts out of an outgoing
 * span's `url.full`.
 *
 * `redactedQueryParams` *replaces* the instrumentation's own list rather than
 * adding to it, so its four defaults are restated here — they are cloud
 * pre-signed-URL parameters, and dropping them to gain ours would be a trade,
 * not a fix. The rest is the list the logs already scrub by (`problem.ts`), so
 * one decision about what a query string may carry covers both sinks.
 */
const REDACTED_QUERY_PARAMS: string[] = [
  // @opentelemetry/instrumentation-http's DEFAULT_QUERY_STRINGS_TO_REDACT.
  'sig',
  'Signature',
  'AWSAccessKeyId',
  'X-Goog-Signature',
  ...SENSITIVE_QUERY_PARAMS,
];

/**
 * `url.path` and `url.query` for an incoming request, scrubbed.
 *
 * The instrumentation sets `url.query` to the raw query string and applies
 * `redactedQueryParams` only to the *outgoing* `url.full`, so every incoming
 * span carried the query verbatim — to a collector, which is the one sink the
 * pino redaction and `serializeRequest` never reach. On this platform that
 * query is where the credentials are: `?token=` on unsubscribe, `?code=` and
 * `?state=` on the four OAuth callbacks, and `?q=` on the admin user search,
 * which is an address an operator typed to find somebody.
 *
 * `scrubUrl` is the logs' own answer — the parameter list for a shapeless
 * credential under a known name, and `scrubSensitive` over the values for a
 * shaped one under a name nobody predicted. `startIncomingSpanHook`'s
 * attributes are merged over the computed ones, so returning these replaces
 * them.
 */
export function incomingSpanUrlAttributes(rawUrl: string | undefined): Record<string, string> {
  if (typeof rawUrl !== 'string' || rawUrl === '') return {};
  const scrubbed = scrubUrl(rawUrl);
  const cut = scrubbed.indexOf('?');
  if (cut === -1) return { 'url.path': scrubbed };
  return { 'url.path': scrubbed.slice(0, cut), 'url.query': scrubbed.slice(cut + 1) };
}

export interface TelemetryHandle {
  shutdown: () => Promise<void>;
}

/**
 * Observability baseline (issue #4; audit B-3 §metrics). Starts an OpenTelemetry
 * NodeSDK exporting OTLP/HTTP **traces and metrics** when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise returns a no-op handle so local
 * dev/tests need no collector. Metrics can be turned off independently with
 * OTEL_METRICS_ENABLED=false (traces stay on).
 *
 * With a reader installed, the RED instruments in `metrics.ts` (request rate /
 * latency / errors) and the pool/queue gauges actually export; without one they
 * record into the API's no-op provider.
 *
 * Must be called before the http/pg modules are used by the service.
 */
export function startTelemetry(service: string, version = '0.1.0'): TelemetryHandle {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return { shutdown: async () => {} };
  }
  const base = endpoint.replace(/\/$/, '');
  const metricsEnabled = (process.env.OTEL_METRICS_ENABLED ?? 'true').toLowerCase() !== 'false';
  const intervalMs = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS) || 15_000;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? service,
      [ATTR_SERVICE_VERSION]: version,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReader: metricsEnabled
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
          exportIntervalMillis: intervalMs,
        })
      : undefined,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => req.url === '/health' || req.url === '/ready',
        // Both directions, because the instrumentation only redacts one of
        // them: `redactedQueryParams` reaches an outgoing `url.full`, and the
        // incoming `url.query` is whatever the caller sent.
        redactedQueryParams: REDACTED_QUERY_PARAMS,
        startIncomingSpanHook: (req) => incomingSpanUrlAttributes(req.url),
      }),
      // `enhancedDatabaseReporting` stays off, and is stated rather than left
      // to the default: turning it on attaches the *parameter values* of every
      // statement to its span, which is this platform's cap tables, addresses
      // and grants going to a collector under a flag that reads like verbosity.
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
