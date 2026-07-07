-- Improvement 8 — white-label partner portal.
-- Per-partner email template overrides for the workflow emails: a jsonb map
-- of template key → { subject, body } with {{placeholder}} substitution.
-- Branding (brand_color, logo_url) and the URL slug (key) already exist.

ALTER TABLE partners ADD COLUMN email_templates jsonb NOT NULL DEFAULT '{}'::jsonb;
