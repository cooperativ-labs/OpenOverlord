-- Per-mission branch automation (coo:16): the branch a mission is currently
-- operating on. The runner writes it when it creates or starts a new cycle of a
-- branch; the REST/mission-panel surfaces read it. Nullable + default null, so
-- existing rows are unaffected and a null value means "no branch prepared yet".
--
-- Contract: database/docs/09-database-schema-contract.md → missions.active_branch

ALTER TABLE missions ADD COLUMN active_branch text;
