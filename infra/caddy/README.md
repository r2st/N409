# Caddy reverse proxy — n409.aiknol.com → web (:3000)

Publishes the N409 web service (host port 3000, binds `0.0.0.0`) at
`https://n409.aiknol.com` with automatic Let's Encrypt TLS, via the Caddy
Docker container already running on `204.168.241.124` for other projects.

This directory is version-controlled config only. Applying it requires SSH to
the server (this repo's tooling could not reach it, so the steps below are
manual).

---

## 1. DNS (do this first — Caddy needs it to issue the cert)

`aiknol.com` is on **Cloudflare** (`*.ns.cloudflare.com`). In the Cloudflare
dashboard → DNS → Records, add:

| Type | Name  | Content (IPv4)    | Proxy status            | TTL  |
| ---- | ----- | ----------------- | ----------------------- | ---- |
| A    | n409  | 204.168.241.124   | **DNS only (grey cloud)** | Auto |

> ⚠️ **Set the proxy to "DNS only" (grey cloud), not "Proxied" (orange).**
> Caddy provisions its own Let's Encrypt cert directly from the origin. With
> the orange cloud on, Cloudflare intercepts :443 and Caddy's TLS-ALPN / HTTP
> challenge can't complete, so cert issuance fails. Grey cloud sends visitors
> straight to the server and lets Caddy manage TLS cleanly.
> (If you specifically want Cloudflare's proxy/CDN in front, that's a different
> setup: use a Cloudflare Origin Certificate + `tls` block instead of Caddy's
> automatic HTTPS, and set the CF SSL mode to Full (strict). Not covered here.)

Verify before continuing:

```sh
dig +short n409.aiknol.com     # must return 204.168.241.124 (NOT a 172.64.x.x
                               # Cloudflare IP — that means it's still proxied)
```

Let's Encrypt validates over the public internet, so the record must resolve
globally before Caddy will succeed.

---

## 2. Preconditions to check on the server

```sh
# a) Caddy container is running and note its name + how it's networked:
docker ps --filter ancestor=caddy --format '{{.Names}}\t{{.Ports}}'
docker ps | grep -i caddy

# b) Ports 80 and 443 must be published by the Caddy container AND open on the
#    Hetzner firewall. From an outside host these currently show "connection
#    refused" — i.e. nothing is listening yet. Confirm on the box:
ss -tlnp | grep -E ':80|:443'          # expect caddy (or docker-proxy) bound
sudo ufw status 2>/dev/null | grep -E '80|443'   # if ufw is in use, allow them
#    Also allow 80/tcp + 443/tcp in the Hetzner Cloud Firewall if one is attached.
```

If Caddy does **not** publish 80/443, it can't get a cert. Fix that first
(publish `-p 80:80 -p 443:443` on the Caddy container / compose service).

---

## 3. Pick the correct upstream address

The web service runs as a host process/container on `0.0.0.0:3000`. Caddy runs
inside Docker, so `localhost` inside the Caddy container is NOT the host. The
shipped config uses `host.docker.internal:3000`. Confirm it resolves from
inside the Caddy container (replace `caddy` with the real container name):

```sh
docker exec -it caddy sh -c 'wget -qO- http://host.docker.internal:3000/ | head -c 80; echo'
```

- **Works** → keep `host.docker.internal:3000` and ensure the container is
  started with `--add-host host.docker.internal:host-gateway` (compose:
  `extra_hosts: ["host.docker.internal:host-gateway"]`). Restart Caddy after
  adding it.
- **Fails** → use one of these instead and edit `n409.aiknol.com.caddy`:
  - `172.17.0.1:3000` — the default docker0 bridge gateway (host from a
    bridge-network container). Find the real gateway with:
    `docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'`
  - `204.168.241.124:3000` — the server's own public IP (always routable since
    the service binds `0.0.0.0`; simplest fallback).
  - `localhost:3000` — only if Caddy runs with `network_mode: host`.

Quick test of any candidate before committing to it:

```sh
docker exec -it caddy sh -c 'wget -qO- http://<CANDIDATE>/ | head -c 80; echo'
```

---

## 4. Install the site config

How depends on how the existing Caddy is configured — check which pattern this
box uses:

```sh
docker inspect caddy -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

**Pattern A — main Caddyfile with an `import` glob** (e.g. the Caddyfile ends
with `import /etc/caddy/sites/*.caddy`): copy this file into the mounted sites
directory on the host, e.g.

```sh
scp infra/caddy/n409.aiknol.com.caddy root@204.168.241.124:/opt/caddy/sites/
```

If there's no `import` line yet, add one to the main Caddyfile once:
`import /etc/caddy/sites/*.caddy`

**Pattern B — single Caddyfile, no imports:** append the contents of
`n409.aiknol.com.caddy` to the host-mounted Caddyfile (keep each site as its
own top-level block).

---

## 5. Reload Caddy (zero-downtime, no restart needed)

```sh
# Validate first:
docker exec -w /etc/caddy caddy caddy validate --config /etc/caddy/Caddyfile
# Graceful reload:
docker exec -w /etc/caddy caddy caddy reload --config /etc/caddy/Caddyfile
```

(If this Caddy uses the JSON config or a different working dir, adjust the
`--config` path to match `docker inspect` output.)

---

## 6. Verify

```sh
curl -sSI https://n409.aiknol.com/ | head -n 5          # expect HTTP/2 200
curl -s  https://n409.aiknol.com/ | grep -o '<title>[^<]*</title>'
docker logs --tail 50 caddy 2>&1 | grep -i n409          # cert issued, no errors
```

Then load `https://n409.aiknol.com/admin/users` in a browser — the users table
should render (verified working against `:3000` directly).

---

## Notes

- Certificate issuance can take 10–30 s on first load; watch `docker logs caddy`.
- After DNS + firewall are correct, cert renewal is automatic — nothing to cron.
- The old direct URL `http://204.168.241.124:3000` keeps working; consider
  firewalling 3000–3004 off the public internet once the domain is live so the
  app is only reachable over TLS.
