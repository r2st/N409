-- Saved worklist views (feature-improvements §2 "Saved views"). The valuations
-- list already keeps its whole filter/column/sort state in the URL query
-- string, which makes a view shareable but not *durable* — every analyst
-- rebuilds "my reviews due this week" by hand each morning.
--
-- A view is therefore stored as the query string itself rather than as a
-- normalised set of filter columns. That keeps this table indifferent to the
-- list gaining a filter (a schema change per new filter would be the
-- alternative), and it means restoring a view is a router navigation with no
-- translation layer. The cost is that the server does not validate the filter
-- semantics — it does not need to: the list endpoint already rejects anything
-- it does not understand, and the query is only ever replayed against that
-- same endpoint under the viewer's own scope.
CREATE TABLE saved_views (
  id                      ulid PRIMARY KEY,
  owner_id                ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                    text NOT NULL,
  -- The list query string without the leading '?', pagination stripped.
  query                   text NOT NULL DEFAULT '',
  -- 'private' is owner-only. 'shared' publishes it to the ops team, which is
  -- what turns a personal habit into team process; only ops may create one.
  visibility              text NOT NULL DEFAULT 'private'
                          CHECK (visibility IN ('private', 'shared')),
  -- The view the list opens on when no filters are in the URL.
  is_default              boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Names are the handle in the picker, so they have to be unambiguous per
-- owner. Case-insensitive: "Overdue" and "overdue" are the same view to a
-- human scanning a dropdown.
CREATE UNIQUE INDEX saved_views_owner_name_idx ON saved_views (owner_id, lower(name));

-- Exactly one default per owner, enforced in the schema rather than in the
-- handler, so a concurrent "make this my default" cannot leave two.
CREATE UNIQUE INDEX saved_views_one_default_idx ON saved_views (owner_id) WHERE is_default;

-- The shared list is read on every visit to the worklist by every ops user.
CREATE INDEX saved_views_shared_idx ON saved_views (name) WHERE visibility = 'shared';
