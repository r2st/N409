-- P2 #11 — notification preferences (docs/n409-remaining-features-spec.md).
-- Sparse, default-on matrix: no row means both channels stay on, so new users
-- never need seeding. Event types are the workflow trigger names frozen in
-- src/domain/emailWorkflows.ts (NOTIFICATION_EVENT_TYPES). Transactional
-- must-sends (password reset, invitations) bypass preferences by design.

CREATE TABLE notification_preferences (
  user_id    ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  in_app     boolean NOT NULL DEFAULT true,
  email      boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_type)
);
