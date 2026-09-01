import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `startTelemetry` is the one place the whole platform decides whether it is
 * observable, and every branch of it is environment-driven: an unset endpoint
 * turns the SDK off entirely, a trailing slash on the endpoint changes the URLs
 * it posts to, and a metrics toggle decides whether the RED instruments in
 * metrics.ts export anywhere. None of that was covered — the module scored 0%,
 * so a service could have been shipped exporting to `https://collector//v1/traces`
 * or with metrics silently off and nothing would have said so.
 *
 * The OTel packages are mocked rather than started: `sdk.start()` patches the
 * http and pg modules process-wide, which is not something a unit test should
 * do to its own worker, and the interesting logic is entirely in the config
 * object handed to `NodeSDK` — so that is what these assert on.
 */

interface CapturedConfig {
  resource: { attributes: Record<string, unknown> };
  traceExporter: { url: string };
  metricReader?: { exporter: { url: string }; exportIntervalMillis: number };
  instrumentations: Array<{ kind: string; options?: Record<string, unknown> }>;
}

const started = vi.fn();
const shutdown = vi.fn(async () => {});
const configs: CapturedConfig[] = [];

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(config: CapturedConfig) {
      configs.push(config);
    }
    start = started;
    shutdown = shutdown;
  },
}));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    url: string;
    constructor(opts: { url: string }) {
      this.url = opts.url;
    }
  },
}));
vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: class {
    url: string;
    constructor(opts: { url: string }) {
      this.url = opts.url;
    }
  },
}));
vi.mock('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: class {
    exporter: { url: string };
    exportIntervalMillis: number;
    constructor(opts: { exporter: { url: string }; exportIntervalMillis: number }) {
      this.exporter = opts.exporter;
      this.exportIntervalMillis = opts.exportIntervalMillis;
    }
  },
}));
vi.mock('@opentelemetry/instrumentation-http', () => ({
  HttpInstrumentation: class {
    kind = 'http';
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
  },
}));
vi.mock('@opentelemetry/instrumentation-pg', () => ({
  PgInstrumentation: class {
    kind = 'pg';
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
    }
  },
}));
// `resourceFromAttributes` replaced `new Resource(...)` in
// @opentelemetry/resources 2.x (round 74's dependency bump). The stub keeps the
// same observable shape — an object carrying `attributes` — because that is
// what the assertions below read.
vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: (attributes: Record<string, unknown>) => ({ attributes }),
}));

const { startTelemetry, incomingSpanUrlAttributes } = await import('../src/otel.js');

const ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_METRICS_ENABLED',
  'OTEL_METRIC_EXPORT_INTERVAL_MS',
  'OTEL_SERVICE_NAME',
] as const;

describe('startTelemetry', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    configs.length = 0;
    started.mockClear();
    shutdown.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('with no collector configured', () => {
    it('starts no SDK at all', () => {
      startTelemetry('valuation');
      expect(configs).toHaveLength(0);
      expect(started).not.toHaveBeenCalled();
    });

    it('returns a handle whose shutdown resolves, so callers need no special case', async () => {
      await expect(startTelemetry('valuation').shutdown()).resolves.toBeUndefined();
    });

    it('treats an empty endpoint as absent rather than as a relative URL', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '';
      startTelemetry('valuation');
      expect(configs).toHaveLength(0);
    });
  });

  describe('with a collector configured', () => {
    it('starts the SDK and routes shutdown to it', async () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
      const handle = startTelemetry('valuation');
      expect(started).toHaveBeenCalledOnce();
      await handle.shutdown();
      expect(shutdown).toHaveBeenCalledOnce();
    });

    it('posts traces and metrics to the signal-specific paths', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
      startTelemetry('valuation');
      expect(configs[0]!.traceExporter.url).toBe('http://collector:4318/v1/traces');
      expect(configs[0]!.metricReader!.exporter.url).toBe('http://collector:4318/v1/metrics');
    });

    it('strips one trailing slash rather than emitting a doubled path', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318/';
      startTelemetry('valuation');
      expect(configs[0]!.traceExporter.url).toBe('http://collector:4318/v1/traces');
    });

    it('names the resource after the service and its version', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
      startTelemetry('report', '2.4.0');
      const attrs = Object.values(configs[0]!.resource.attributes);
      expect(attrs).toContain('report');
      expect(attrs).toContain('2.4.0');
    });

    it('lets OTEL_SERVICE_NAME override the service argument', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
      process.env.OTEL_SERVICE_NAME = 'valuation-canary';
      startTelemetry('valuation');
      expect(Object.values(configs[0]!.resource.attributes)).toContain('valuation-canary');
    });

    it('defaults the version when the caller does not pass one', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
      startTelemetry('valuation');
      expect(Object.values(configs[0]!.resource.attributes)).toContain('0.1.0');
    });

    it('instruments http and pg', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
      startTelemetry('valuation');
      expect(configs[0]!.instrumentations.map((i) => i.kind)).toEqual(['http', 'pg']);
    });

    it('keeps the probe endpoints out of the trace stream', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
      startTelemetry('valuation');
      const hook = configs[0]!.instrumentations[0]!.options!.ignoreIncomingRequestHook as (req: {
        url?: string;
      }) => boolean;
      // The load balancer hits these every few seconds; sampled, they would be
      // most of the spans in the collector and none of the interesting ones.
      expect(hook({ url: '/health' })).toBe(true);
      expect(hook({ url: '/ready' })).toBe(true);
      expect(hook({ url: '/api/v1/valuations' })).toBe(false);
      expect(hook({})).toBe(false);
    });
  });

  describe('what a span is allowed to carry', () => {
    beforeEach(() => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
    });

    // The collector is a sink the pino redaction and `serializeRequest` never
    // reach: the instrumentation reads the request itself. It sets `url.query`
    // to the raw query string, and applies its own `redactedQueryParams` only
    // to an outgoing `url.full` — so every incoming span carried the query
    // verbatim, which on this platform is where the credentials are.
    it('scrubs the query off an incoming span', () => {
      startTelemetry('valuation');
      const hook = configs[0]!.instrumentations[0]!.options!.startIncomingSpanHook as (req: {
        url?: string;
      }) => Record<string, string>;
      expect(hook({ url: '/api/v1/unsubscribe?token=abc.def' })).toEqual({
        'url.path': '/api/v1/unsubscribe',
        'url.query': 'token=[REDACTED]',
      });
      // `q` is deliberately not on the parameter list — free text is the most
      // useful thing in the line — so the *value* is what has to be scrubbed.
      expect(hook({ url: '/api/v1/admin/users?q=ada%40acme.com' })['url.query']).not.toContain(
        'ada@acme.com',
      );
      // No query, nothing invented.
      expect(hook({ url: '/api/v1/valuations' })).toEqual({ 'url.path': '/api/v1/valuations' });
      expect(hook({})).toEqual({});
    });

    it('redacts the same parameters out of an outgoing url', () => {
      startTelemetry('valuation');
      const params = configs[0]!.instrumentations[0]!.options!.redactedQueryParams as string[];
      // Ours…
      for (const p of ['token', 'code', 'state', 'email', 'api_key']) expect(params).toContain(p);
      // …without dropping the instrumentation's own, which this option replaces
      // rather than extends.
      for (const p of ['sig', 'Signature', 'AWSAccessKeyId', 'X-Goog-Signature']) {
        expect(params).toContain(p);
      }
    });

    it('never asks pg to report parameter values', () => {
      startTelemetry('valuation');
      // A flag that reads like verbosity and means "attach every statement's
      // parameters" — this platform's cap tables, addresses and grants.
      expect(configs[0]!.instrumentations[1]!.options).toEqual({ enhancedDatabaseReporting: false });
    });
  });

  describe('incomingSpanUrlAttributes', () => {
    it('splits on the first ? so a scrubbed value carrying one stays in the query', () => {
      expect(incomingSpanUrlAttributes('/a?b=1?2')).toEqual({
        'url.path': '/a',
        'url.query': 'b=1?2',
      });
    });

    it('answers an absent url with no attributes at all', () => {
      expect(incomingSpanUrlAttributes(undefined)).toEqual({});
      expect(incomingSpanUrlAttributes('')).toEqual({});
    });
  });

  describe('metrics toggle', () => {
    beforeEach(() => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
    });

    it('installs a reader by default', () => {
      startTelemetry('valuation');
      expect(configs[0]!.metricReader).toBeDefined();
    });

    it('omits the reader when metrics are disabled', () => {
      process.env.OTEL_METRICS_ENABLED = 'false';
      startTelemetry('valuation');
      expect(configs[0]!.metricReader).toBeUndefined();
      // Traces are a separate signal and stay on.
      expect(configs[0]!.traceExporter.url).toBe('http://collector:4318/v1/traces');
    });

    it('accepts the disable flag in any case', () => {
      process.env.OTEL_METRICS_ENABLED = 'FALSE';
      startTelemetry('valuation');
      expect(configs[0]!.metricReader).toBeUndefined();
    });

    it('treats any other value as enabled rather than as off', () => {
      process.env.OTEL_METRICS_ENABLED = 'no';
      startTelemetry('valuation');
      expect(configs[0]!.metricReader).toBeDefined();
    });

    it('exports on the configured interval', () => {
      process.env.OTEL_METRIC_EXPORT_INTERVAL_MS = '5000';
      startTelemetry('valuation');
      expect(configs[0]!.metricReader!.exportIntervalMillis).toBe(5_000);
    });

    it('falls back to 15s when the interval is unset or unparseable', () => {
      startTelemetry('valuation');
      expect(configs[0]!.metricReader!.exportIntervalMillis).toBe(15_000);

      configs.length = 0;
      process.env.OTEL_METRIC_EXPORT_INTERVAL_MS = 'soon';
      startTelemetry('valuation');
      expect(configs[0]!.metricReader!.exportIntervalMillis).toBe(15_000);
    });

    it('rejects a zero interval, which would otherwise mean a hot export loop', () => {
      process.env.OTEL_METRIC_EXPORT_INTERVAL_MS = '0';
      startTelemetry('valuation');
      expect(configs[0]!.metricReader!.exportIntervalMillis).toBe(15_000);
    });
  });
});
