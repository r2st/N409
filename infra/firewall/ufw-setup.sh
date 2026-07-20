#!/usr/bin/env bash
# Host firewall for the N409 Hetzner box (audit B-1 P0 / I-1 P1).
#
# The five services bind to host ports 3000–3004. Only :3000 (the web/BFF) and
# the Caddy TLS ports need to face the internet; the internal services
# (valuation 3001, ai 3002, engine-wrapper 3003, report 3004) must NOT be
# world-reachable. Before this, "ufw inactive" left the unauthenticated AI and
# engine services open to anyone who could hit the box — the P0.
#
# The Python services now also bind 127.0.0.1 and require X-Internal-Token, so
# this firewall is defence-in-depth, not the sole control. Run once as root:
#   sudo bash infra/firewall/ufw-setup.sh
set -euo pipefail

if ! command -v ufw >/dev/null; then
  echo "installing ufw…"
  apt-get update -y && apt-get install -y ufw
fi

ufw --force reset

# Default deny inbound, allow outbound.
ufw default deny incoming
ufw default allow outgoing

# SSH — keep your session alive. Restrict to an admin CIDR in production.
ufw allow 22/tcp comment 'ssh'

# Public web: Caddy TLS + the web/BFF SPA host.
ufw allow 80/tcp comment 'http (caddy redirect)'
ufw allow 443/tcp comment 'https (caddy)'
ufw allow 3000/tcp comment 'n409-web (SPA + /api proxy)'

# Internal services are reachable only over loopback — do NOT open 3001–3004.
# (They are listed here as an explicit reminder, denied by the default policy.)
#   3001 valuation, 3002 ai, 3003 engine-wrapper, 3004 report

# Belt-and-braces explicit denies in case a later rule opens them broadly.
for p in 3001 3002 3003 3004; do
  ufw deny "${p}/tcp" comment "internal service ${p} — loopback only"
done

ufw --force enable
ufw status verbose
