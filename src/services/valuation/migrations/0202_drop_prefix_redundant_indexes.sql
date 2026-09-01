-- Seven indexes that no query can reach that another index does not also reach.
--
-- Each is a plain btree on one column which is the *leading column* of a UNIQUE
-- composite on the same table, with the same opclass, collation and direction:
--
--     accounting_connections (valuation_id)   <  (valuation_id, provider)
--     cap_table_connections  (valuation_id)   <  (valuation_id, provider)
--     hris_connections       (valuation_id)   <  (valuation_id, provider)
--     mfa_backup_codes       (user_id)        <  (user_id, code_hash)
--     overwrites             (valuation_id)   <  (valuation_id, field_key)
--     valuation_signatures   (valuation_id)   <  (valuation_id, role)
--     valuation_tags         (valuation_id)   <  (valuation_id, slug)
--
-- The mechanism, rather than a row count: for two btrees with no predicate and
-- no expression, where one's key columns are a prefix of the other's under the
-- same opclass/collation/direction, every plan available on the narrow one is
-- available on the wide one. The same index conditions are seekable (they are
-- the same leading keys), the same orderings are produced (a longer pathkey list
-- satisfies a request for its prefix), and an index-only scan of the narrow one
-- is an index-only scan of the wide one carrying an extra column. Nothing is
-- lost by dropping it but the marginally smaller scan, and what is bought is one
-- fewer index to maintain on every insert, and on every UPDATE that touches the
-- column — which for `valuation_signatures`, `overwrites` and the three
-- connection tables is the ordinary write path.
--
-- These are six of the seven pairs the census in `redundantIndexCensus.test.ts`
-- finds; the seventh was `email_outbox_status_idx`, dropped by 0201 for the
-- same reason and measured there. The census is now a standing guard, so the
-- next one has to be argued for rather than merely typed. It is spelled against
-- `pg_index` — comparing `indkey`, `indclass`, `indcollation` and `indoption`
-- rather than the text of `pg_get_indexdef` — because a DESC or a NULLS
-- placement that differs is the whole difference between a redundant index and
-- a necessary one (0170).
--
-- Every one of these is a hand-written `CREATE INDEX ... (valuation_id)` sitting
-- a few lines from the `UNIQUE (valuation_id, …)` that subsumes it, in the same
-- migration. The FK-covering habit is the reason — R92 established that an
-- unindexed FK costs nothing here because almost nothing is hard-deleted — and
-- the composite already covers the FK. So this is not a change of policy about
-- FK indexes; it is the observation that seven of them were written twice.

DROP INDEX IF EXISTS accounting_connections_valuation_idx;
DROP INDEX IF EXISTS cap_table_connections_valuation_idx;
DROP INDEX IF EXISTS hris_connections_valuation_idx;
DROP INDEX IF EXISTS mfa_backup_codes_user_idx;
DROP INDEX IF EXISTS overwrites_valuation_idx;
DROP INDEX IF EXISTS valuation_signatures_valuation_idx;
DROP INDEX IF EXISTS valuation_tags_valuation_idx;
