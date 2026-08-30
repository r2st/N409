-- Where an in-app notification points (R218).
--
-- A notification is drawn with an "Open →" link only when it carries a
-- `valuation_id`, because that was the only destination the table could name.
-- Every engagement-scoped notification has one and is fine. The account-scoped
-- half does not — a subscription belongs to no engagement — so the billing
-- notifications arrive as a sentence naming an action with no way to take it:
--
--   "A payment of $99.00 was declined. Update your card from the billing page
--    to keep your plan active."
--
-- …rendered as text, in a list, next to nothing clickable, while the email sent
-- in the same breath carries `billing_link` and lands the reader on the page.
-- The two halves of one message disagree about whether the reader can act on
-- it, and the in-app half is the one the notification centre exists to serve.
--
-- An app-relative path, never an absolute URL. The column is written only by
-- this service — no request body reaches it — but a notification body is
-- rendered as a link target in the browser, and a stored `//host` or
-- `javascript:` would be an open redirect out of the reader's own inbox. The
-- constraint is the cheap half of that; `domain/notificationLink.ts` refuses
-- the same shapes at the write, and the page refuses them again at render.
ALTER TABLE notifications ADD COLUMN link text;

ALTER TABLE notifications ADD CONSTRAINT notifications_link_relative_check
  CHECK (link IS NULL OR (link ~ '^/[^/\\]' AND link !~ '[[:cntrl:]]'));
