-- Audit-defense toolkit (IMPROVEMENTS_RESEARCH §5.3): every methodology
-- decision recorded with its rationale, append-only. A revised decision points
-- at the row it supersedes — history is never rewritten. Rows are exported in
-- the evidence bundle as decisions.json.
CREATE TABLE methodology_decisions (
  id           ulid PRIMARY KEY,
  valuation_id ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  category     text NOT NULL CHECK (category IN (
    'approach_selection','weighting','dlom','dloc','volatility',
    'discount_rate','comparables','backsolve','allocation','other'
  )),
  decision     text NOT NULL,
  rationale    text NOT NULL,
  supersedes   ulid REFERENCES methodology_decisions(id),
  decided_by   ulid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX methodology_decisions_valuation_idx
  ON methodology_decisions (valuation_id, created_at ASC);
