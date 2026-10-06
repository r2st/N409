-- Email subscriber list for 409A compliance deadline notifications
CREATE TABLE IF NOT EXISTS email_subscribers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_subscribers_email_unique UNIQUE (email)
);
