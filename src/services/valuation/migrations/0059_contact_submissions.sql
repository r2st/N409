-- Public marketing contact form (409.ai gap #28).
--
-- The marketing site's /contact page posts here without authentication, so the
-- table stands alone (no FK to users) and stores exactly what the form
-- collects. Ops read the queue and mark each submission handled; there is no
-- update path for the submitter.
CREATE TYPE contact_submission_status AS ENUM ('new', 'handled');

CREATE TABLE contact_submissions (
  id         ulid PRIMARY KEY,
  name       text NOT NULL,
  email      text NOT NULL,
  company    text,
  phone      text,
  message    text NOT NULL,
  status     contact_submission_status NOT NULL DEFAULT 'new',
  handled_by ulid REFERENCES users(id),
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contact_submissions_status_idx ON contact_submissions (status, created_at DESC);
