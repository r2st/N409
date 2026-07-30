/**
 * Which interface a service binds.
 *
 * Loopback by default. Every Node service used to hard-code `0.0.0.0`, which
 * publishes it on every interface the box has — including the public one. Ports
 * 3001–3004 carry no user-facing authentication (the valuation service trusts
 * the internal token; report and the SPA host trust their caller), so the host
 * firewall was the only thing between the open internet and them. A firewall
 * rule is a fine second layer, but it should not be the first.
 *
 * This matches what the Python services already do — `ENV HOST=127.0.0.1` in
 * their Dockerfiles, `--host 127.0.0.1` in their systemd units — so all five
 * services now answer the question the same way.
 *
 * `HOST` overrides it, because containers genuinely need `0.0.0.0`: Docker
 * publishes a port by reaching the container's own interface, so a loopback bind
 * inside a container is unreachable from outside it. docker-compose sets it
 * explicitly for exactly that reason.
 */
export const DEFAULT_LISTEN_HOST = '127.0.0.1';

export function listenHost(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HOST?.trim();
  return configured ? configured : DEFAULT_LISTEN_HOST;
}
