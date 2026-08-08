-- Partner subdomains — the address a white-label firm actually gives its
-- clients.
--
-- 0091 gave a firm its colours, logo and name. What it did not give them was a
-- URL: branding resolved from `partners.key` on `/public/branding/:key`, so a
-- firm's client still arrived at the platform's own host and read the platform's
-- name in the address bar while looking at the firm's logo. Half a white label
-- is arguably worse than none — it tells the client there is a vendor behind
-- the firm without telling them who.
--
-- `subdomain` is deliberately separate from `key`. `key` is the internal
-- identifier ops chose, it appears in URLs we control, and renaming it breaks
-- links. A subdomain is public-facing, chosen by the firm, and has to satisfy
-- DNS rules `key` never did. Conflating them would mean a firm cannot change
-- its public address without changing its API identity.

ALTER TABLE partners
  ADD COLUMN subdomain text
    -- RFC 1123 label: lowercase alphanumerics and hyphens, no leading or
    -- trailing hyphen, 3–63 characters. Enforced here as well as in
    -- domain/partnerSubdomain.ts because a bad row is unreachable rather than
    -- merely ugly — nothing would ever resolve it.
    CHECK (subdomain IS NULL OR subdomain ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$');

-- Two firms cannot share an address. Partial, so the many partners with no
-- subdomain do not collide on NULL.
CREATE UNIQUE INDEX partners_subdomain_key ON partners (subdomain) WHERE subdomain IS NOT NULL;
