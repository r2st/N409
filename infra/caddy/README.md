# The public edge — `n409.aiknol.com`

This is the only N409 surface on the internet. Everything behind it binds
loopback: `ss -tlnp` on the host shows web and valuation on `127.0.0.1:3000` and
`127.0.0.1:3001`, and ufw publishes only 22, 80 and 443.

## What is actually deployed

- **Caddy v2.11, installed natively** — systemd unit `caddy`
  (`/usr/lib/systemd/system/caddy.service`), config `/etc/caddy/Caddyfile`.
  There is **no Docker on this host at all**.
- That one Caddyfile also serves two unrelated products from the same ports.
  `n409.aiknol.com.caddy` in this directory is **the n409 site block only**, kept
  here so the routing is reviewable without ssh. Do not install it as a whole
  Caddyfile — that would take the other two sites down. Edit the corresponding
  block in place, or `import` it.
- **DNS is on Cloudflare and the record is proxied** (orange cloud):
  `dig +short n409.aiknol.com` returns Cloudflare addresses, not
  204.168.241.124. See the section below — this has consequences.

Everything above was measured on the host on 2026-08-21. What this file said
before described a Caddy running in Docker and reached at
`host.docker.internal:3000`, which has never been true here; following it would
have produced a site that could not reach its own backend, and would have
dropped the `/scim/v2/*` route entirely, silently 404ing every SCIM
provisioning request from every configured IdP. Stale infrastructure config is
worse than none, because it invites someone to apply it.

## Cloudflare is in front, and the app has to know

The chain is `client → Cloudflare edge → Caddy → web`. Cloudflare sets
`X-Forwarded-For` to the client and Caddy appends the edge address it was
dialled from, so the header arrives as `<client>, <cloudflare edge>`.

Fastify walks that chain inward from the socket and stops at the first hop it is
not told to trust. Until R88 the Cloudflare edge was not in `TRUSTED_PROXIES`,
so it stopped there and **`req.ip` was a Cloudflare datacenter for every request
on the internet** — which is what the fourteen per-IP throttles were keyed on,
`login-ip:` and `register-ip:` and `reset-ip:` included. The host now sets:

```
TRUSTED_PROXIES=loopback, uniquelocal, cloudflare
```

`cloudflare` is a named token that expands to Cloudflare's published ranges; see
`src/packages/shared/src/clientIp.ts` for the list, the date it was fetched, and
the trade it makes.

**Open item.** Trusting those ranges is only completely safe once the origin
accepts 80/443 *from* those ranges alone — otherwise code running on Cloudflare
can reach 204.168.241.124 directly and forge the header. That change is not made
here because Caddy serves two other products from the same ports. See
`infra/DEPLOYMENT.md`.

## The deploy checks this file against the host

`infra/deploy.sh` section 4d runs `infra/check-caddy.mjs` on the box before it
restarts anything, and **a difference fails the deploy**. So if you edit the
`n409.aiknol.com` block in `/etc/caddy/Caddyfile` by hand, make the same edit
here — otherwise the next deploy stops, with the previous release still serving.

It cannot install the way `install-units.sh` does, because the host's Caddyfile
is shared with two other products and copying ours over it would take them down.
Reporting is the only safe direction. It compares *what Caddy would do* — the
trusted-proxy set, and the site block's directives in order — not the bytes, so
the two files are free to be indented differently and to carry their own
comments. Order is not cosmetic in the site block: `handle` is first-match-wins.

Run it yourself against any config:

```sh
node infra/check-caddy.mjs --live /etc/caddy/Caddyfile   # 0 match, 1 drift, 2 unreadable
```

`SKIP_CADDY_CHECK=1` overrides it for one deploy.

## Verify

```sh
curl -sSI https://n409.aiknol.com/ | head -n 3            # HTTP/2 200
curl -so /dev/null -w '%{http_code}\n' \
  https://n409.aiknol.com/scim/v2/ServiceProviderConfig   # 200, not 404
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy                               # zero-downtime
journalctl -u caddy --since '5 min ago' | grep -i n409
```

To confirm the client IP is resolving correctly, make a request and read it back
out of the service log — it should be your address, not a Cloudflare one:

```sh
curl -s "https://n409.aiknol.com/?probe=$$" >/dev/null
ssh root@204.168.241.124 \
  "journalctl -u n409-web --since '1 min ago' -o cat | grep -F 'probe=$$'"
curl -s https://api.ipify.org; echo                        # compare
```

## DNS

`aiknol.com` is on Cloudflare. The record for `n409` is an A to
204.168.241.124, currently **proxied**. Caddy still holds a valid Let's Encrypt
certificate for the origin, and Cloudflare presents its own at the edge.

Switching the record to DNS-only (grey cloud) would also be a valid deployment —
it removes the extra hop and makes the `cloudflare` entry in `TRUSTED_PROXIES`
inert rather than wrong — but it is not the current one, and this file used to
assert it was.
