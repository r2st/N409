import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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
      req.log.error({ err }, 'unhandled error');
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
