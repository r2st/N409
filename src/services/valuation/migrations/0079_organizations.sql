-- Multi-entity / fund portfolio structure (feature 6). Introduces an
-- organization (holding company / fund) above the valuation-as-business level,
-- with a self-referential parent for holdco hierarchies. Each valuation (the
-- de-facto business record, keyed by company_name) gains an organization
-- membership, an entity_type, and an inter-company parent reference to another
-- valuation for subsidiary relationships.
CREATE TABLE organizations (
  id            ulid PRIMARY KEY,
  name          text NOT NULL,
  entity_type   text NOT NULL DEFAULT 'holding_company'
                CHECK (entity_type IN ('holding_company', 'fund', 'operating_group')),
  -- Holdco tree: an organization may roll up into a parent organization.
  parent_org_id ulid REFERENCES organizations(id) ON DELETE SET NULL,
  owner_user_id ulid NOT NULL REFERENCES users(id),
  created_by    ulid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organizations_owner_idx ON organizations (owner_user_id);
CREATE INDEX organizations_parent_idx ON organizations (parent_org_id);

ALTER TABLE valuations
  ADD COLUMN organization_id ulid REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN entity_type text NOT NULL DEFAULT 'standalone'
    CHECK (entity_type IN ('standalone', 'parent', 'subsidiary', 'portfolio_company')),
  -- Inter-company reference: this business rolls up to another valuation.
  ADD COLUMN parent_valuation_id ulid REFERENCES valuations(id) ON DELETE SET NULL;

CREATE INDEX valuations_organization_idx ON valuations (organization_id);
CREATE INDEX valuations_parent_valuation_idx ON valuations (parent_valuation_id);
