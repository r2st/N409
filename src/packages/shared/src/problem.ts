import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Scrubs secrets/PII that can slip into a free-text error `message` or `stack`
 * (audit B-1 P3). Pino's `redact` paths only cover structured fields, so a
 * thrown `Error("... postgres://user:pw@host ...")` would otherwise reach the
 * logs verbatim. Applied only to the 5xx log line; the client body never
 * includes the message.
 */
export function scrubSensitive(text: string): string {
  if (!text) return text;
  return (
    text
      // credentials embedded in DSNs: keep scheme + host, drop user:password
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s:/@]+@/gi, '$1[REDACTED]@')
      // bearer / authorization tokens
      .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]')
      // JWTs (three base64url segments)
      .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED-JWT]')
      // common API-key shapes (sk-..., AKIA..., long hex/base64 secrets)
      .replace(/\b(?:sk|rk|pk)[-_][A-Za-z0-9]{16,}\b/g, '[REDACTED-KEY]')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-KEY]')
      // email addresses
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED-EMAIL]')
      // US SSN
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]')
  );
}

/** Returns a log-safe view of an error with message/stack scrubbed. */
export function scrubError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: scrubSensitive(err.message),
      stack: err.stack ? scrubSensitive(err.stack) : undefined,
    };
  }
  return { message: scrubSensitive(String(err)) };
}

/**
 * RFC 9457 application/problem+json error (api-design.md §1).
 */
export class ApiProblem extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail?: string;
  readonly extensions?: Record<string, unknown>;

  constructor(args: {
    status: number;
    title: string;
    type?: string;
    detail?: string;
    extensions?: Record<string, unknown>;
  }) {
    super(args.detail ?? args.title);
    this.status = args.status;
    this.title = args.title;
    this.type = args.type ?? 'about:blank';
    this.detail = args.detail;
    this.extensions = args.extensions;
  }

  toBody(instance?: string): Record<string, unknown> {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(instance ? { instance } : {}),
      ...this.extensions,
    };
  }
}

export const problems = {
  badRequest: (detail?: string, extensions?: Record<string, unknown>) =>
    new ApiProblem({
      status: 400,
      title: 'Bad Request',
      type: 'urn:n409:problem:bad-request',
      detail,
      extensions,
    }),
  unauthorized: (detail = 'Authentication required') =>
    new ApiProblem({ status: 401, title: 'Unauthorized', type: 'urn:n409:problem:unauthorized', detail }),
  forbidden: (detail = 'Not allowed') =>
    new ApiProblem({ status: 403, title: 'Forbidden', type: 'urn:n409:problem:forbidden', detail }),
  notFound: (detail = 'Resource not found') =>
    new ApiProblem({ status: 404, title: 'Not Found', type: 'urn:n409:problem:not-found', detail }),
  conflict: (detail?: string) =>
    new ApiProblem({ status: 409, title: 'Conflict', type: 'urn:n409:problem:conflict', detail }),
  unprocessable: (detail?: string, extensions?: Record<string, unknown>) =>
    new ApiProblem({
      status: 422,
      title: 'Unprocessable Entity',
      type: 'urn:n409:problem:validation',
      detail,
      extensions,
    }),
  tooManyRequests: (detail = 'Too many requests — try again later') =>
    new ApiProblem({
      status: 429,
      title: 'Too Many Requests',
      type: 'urn:n409:problem:rate-limited',
      detail,
    }),
  serviceUnavailable: (detail = 'Service temporarily unavailable') =>
    new ApiProblem({
      status: 503,
      title: 'Service Unavailable',
      type: 'urn:n409:problem:unavailable',
      detail,
    }),
};

/**
 * Installs a fastify error handler that renders every error as problem+json
 * and never leaks internals on 5xx.
 */
export function registerProblemHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ApiProblem) {
      return reply.status(err.status).type('application/problem+json').send(err.toBody(req.url));
    }
    const fastifyErr = err as { statusCode?: number; message?: string };
    const status = fastifyErr.statusCode && fastifyErr.statusCode < 500 ? fastifyErr.statusCode : 500;
    if (status >= 500) {
      // Scrub the free-text message/stack — pino `redact` only masks structured
      // fields, so secrets interpolated into an Error string would leak (B-1 P3).
      req.log.error({ err: scrubError(err) }, 'unhandled error');
    }
    return reply
      .status(status)
      .type('application/problem+json')
      .send({
        type: 'about:blank',
        title: status >= 500 ? 'Internal Server Error' : (fastifyErr.message ?? 'Request Error'),
        status,
        instance: req.url,
      });
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .status(404)
      .type('application/problem+json')
      .send({ type: 'urn:n409:problem:not-found', title: 'Not Found', status: 404, instance: req.url }),
  );
}
