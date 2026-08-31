import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { problems } from '@n409/shared';
import { refuseSso } from '../../src/auth/ssoRefusal.js';

/**
 * R273 (methodology M11) — the refusal is recorded, not the redirect.
 *
 * `refuseSso` used to test `browserNavigation` first and throw the problem
 * before it wrote anything, so whether an identity-provider refusal left a
 * trace depended on whether the caller had asked for HTML. Nothing downstream
 * covers the other branch: `registerProblemHandler` logs 4xx nowhere — on the
 * stated ground that a 4xx "describes the request, the caller was told" — and
 * twelve of the seventeen call sites carry no spine event and no `err` line of
 * their own. So an assertion turned away for a domain that is not allowed, an
 * address the provider never verified, or a flow switched off between the link
 * and the click was, for a non-HTML caller, a status code and nothing else.
 *
 * Held here as behaviour rather than as a source scan because the property is
 * about the two branches agreeing, and a scan cannot see that the log call sits
 * above the `throw` rather than after it.
 */

function fakeRequest(accept: string | undefined): {
  req: FastifyRequest;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const req = {
    headers: accept === undefined ? {} : { accept },
    method: 'POST',
    url: '/api/v1/auth/saml/acs',
    routeOptions: { url: '/api/v1/auth/saml/acs' },
    log: { warn },
  } as unknown as FastifyRequest;
  return { req, warn };
}

const reply = { redirect: vi.fn(() => reply) } as unknown as FastifyReply;

describe('an SSO refusal is recorded however it is answered (R273)', () => {
  it('writes the line when the browser is sent back to sign in', () => {
    const { req, warn } = fakeRequest('text/html,application/xhtml+xml');
    refuseSso(req, reply, 'domain_not_allowed', problems.forbidden('nope'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      ssoRefusal: 'domain_not_allowed',
      answered: 'redirect',
    });
  });

  it('writes it for an API caller too, whose problem body nothing else logs', () => {
    const { req, warn } = fakeRequest('application/json');
    expect(() => refuseSso(req, reply, 'domain_not_allowed', problems.forbidden('nope'))).toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      ssoRefusal: 'domain_not_allowed',
      answered: 'problem',
    });
  });

  it('and for a caller that sent no Accept header at all', () => {
    const { req, warn } = fakeRequest(undefined);
    expect(() => refuseSso(req, reply, 'assertion_reused', problems.unauthorized('spent'))).toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  /*
   * The code alone does not say which door. `not_configured` is raised by four
   * routes across the two flows, and `invalid_request` by three, so a line
   * carrying only the code leaves an operator joining on `requestId` to the
   * `incoming request` line — which is written at `info` and is gone from a
   * deployment running at `warn`.
   */
  it('names the route, so the line stands on its own', () => {
    const { req, warn } = fakeRequest('text/html');
    refuseSso(req, reply, 'not_configured', problems.badRequest('off'));
    expect(warn.mock.calls[0]![0]).toMatchObject({
      route: '/api/v1/auth/saml/acs',
      method: 'POST',
      actor: 'anonymous',
    });
  });

  it('keeps the record above the branch, not inside it', () => {
    // The regression this round fixed is positional: a `throw` reached before
    // the log call restores it without changing anything a type checker sees.
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/auth/ssoRefusal.ts'),
      'utf8',
    );
    const body = source.slice(source.indexOf('export function refuseSso'));
    expect(body.indexOf('req.log.warn')).toBeGreaterThan(-1);
    expect(body.indexOf('req.log.warn')).toBeLessThan(body.indexOf('throw problem'));
  });
});
