-- White-label branding — a firm's own identity across the whole product.
--
-- 0047 gave partners a `brand_color` and `logo_url` that only ever reached the
-- partner login page and the PDF cover. Selling to valuation firms means the
-- signed-in application has to wear the firm's identity too, so branding grows
-- into a first-class per-tenant record: display name, light/dark logos,
-- favicon, accent colour and the switch that turns it all on.
--
-- `white_label_enabled` defaults to false: an existing partner keeps N409
-- branding until someone deliberately turns their own on, so this migration
-- changes nothing visually on its own.

ALTER TABLE partners
  -- Public-facing firm name. Distinct from `name`, which is the internal label
  -- ops picked for the channel and is not necessarily what clients should read.
  ADD COLUMN brand_name text,
  -- Accent used on dark surfaces. The light accent stays in `brand_color`;
  -- one colour cannot satisfy contrast on both grounds.
  ADD COLUMN accent_color_dark text
    CHECK (accent_color_dark IS NULL OR accent_color_dark ~ '^#[0-9a-fA-F]{6}$'),
  -- Logo variant for dark chrome (the app sidebar, the auth panel). Optional:
  -- resolution falls back to the light logo when a firm only supplies one.
  ADD COLUMN logo_dark_url text,
  ADD COLUMN favicon_url text,
  -- Shown in the app footer and used as the reply-to hint in branded emails.
  ADD COLUMN support_email text,
  ADD COLUMN brand_tagline text,
  ADD COLUMN white_label_enabled boolean NOT NULL DEFAULT false;

-- The signed-in SPA resolves branding by tenant on every load, and the public
-- login page resolves it by slug; both are hot paths against a small table, but
-- the partial index keeps the enabled set trivially scannable.
CREATE INDEX partners_white_label_idx ON partners (id) WHERE white_label_enabled;
