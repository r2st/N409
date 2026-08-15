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

/**
 * Which port a service binds — the other half of the address, held to the same
 * standard as {@link listenHost}.
 *
 * `HOST=` (bare, no value) used to bind every interface; that was fixed above by
 * treating blank as unset. `PORT=` was left doing the analogous thing and is
 * worse, because it does not fail and it does not do what it says: `Number('')`
 * is `0`, and `listen({ port: 0 })` is Node's documented request for *a random
 * free port*. So a unit whose `PORT=` line lost its value — an unexpanded
 * `${...}`, a trailing edit, a copied comment — starts cleanly, logs
 * `listening`, reports the unit active, and answers on an ephemeral port nobody
 * will ever dial. Caddy gets connection refused against 3000; `deploy.sh` gets
 * a health probe that never succeeds; nothing anywhere says the word "port".
 *
 * The other two spellings are loud but unhelpful: `PORT=abc` and `PORT=70000`
 * both reach `listen()` and die with a bare `ERR_SOCKET_BAD_PORT` naming
 * neither the variable nor the file it came from.
 *
 * All three are the same mistake and all three are refused here, before the
 * server exists, with a message that names the variable and the value it was
 * given. An absent `PORT` is still fine — that is what `fallback` is for, and
 * it is how every service runs locally.
 *
 * @param fallback port to use when `PORT` is absent from the environment
 * @throws Error naming `PORT` and the offending value
 */
export function listenPort(fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT;
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error(
      'PORT is set but empty — Node reads an empty port as 0, which binds a random ephemeral ' +
        'port rather than the one this service is dialled on. Give it a value or unset it.',
    );
  }
  // Plain decimal digits only, rather than whatever `Number` is willing to read.
  // `Number('0x0bb8')` is 3000 and `Number('1e3')` is 1000 — both are integers
  // in range, and neither is a port anyone meant to write. A spelling this
  // function cannot state back to the operator is a spelling it should refuse.
  const port = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a decimal integer between 1 and 65535 — got "${raw}"`);
  }
  return port;
}
