import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
// Metric packages are hard dependencies of @opentelemetry/sdk-node (already a
// direct dependency), so importing them transitively is version-safe.
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

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
    resource: new Resource({
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
      }),
      new PgInstrumentation(),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
