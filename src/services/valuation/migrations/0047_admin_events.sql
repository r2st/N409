-- P2 #12 — activity audit log viewer (docs/n409-remaining-features-spec.md).
-- Non-valuation admin actions (user/role changes, partner edits, prompt and
-- template changes) get their own append-only spine, same shape as
-- valuation_events but keyed by subject instead of valuation. subject_label
-- is denormalized at write time so the viewer renders without joining every
-- subject table.

CREATE TABLE admin_events (
  id            ulid PRIMARY KEY,
  type          text NOT NULL,
  actor_type    actor_type NOT NULL,
  actor_id      text,
  source        text,
  subject_type  text NOT NULL,
  subject_id    text,
  subject_label text,
  payload       jsonb NOT NULL DEFAULT '{}',
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_events_occurred_idx ON admin_events (occurred_at DESC);
CREATE INDEX admin_events_actor_idx    ON admin_events (actor_id, occurred_at DESC);
CREATE INDEX admin_events_subject_idx  ON admin_events (subject_type, subject_id);

-- Same immutability contract as valuation_events (function from 0001).
CREATE TRIGGER admin_events_immutable
  BEFORE UPDATE OR DELETE ON admin_events
  FOR EACH ROW EXECUTE FUNCTION forbid_event_mutation();
CREATE TRIGGER admin_events_no_truncate
  BEFORE TRUNCATE ON admin_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_event_mutation();

-- The global viewer lists valuation_events cross-valuation — index the sort
-- and the actor filter (0001 only indexed per-valuation access).
CREATE INDEX valuation_events_occurred_idx ON valuation_events (occurred_at DESC);
CREATE INDEX valuation_events_actor_idx    ON valuation_events (actor_id, occurred_at DESC);
