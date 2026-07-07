-- P1 #7 — partner portal management (docs/n409-remaining-features-spec.md).
-- Soft-archive so a channel can be closed without breaking historical rows,
-- plus lightweight branding partners can surface in their portal.

ALTER TABLE partners ADD COLUMN archived_at timestamptz;
ALTER TABLE partners ADD COLUMN brand_color text
  CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-fA-F]{6}$');
ALTER TABLE partners ADD COLUMN logo_url text;
