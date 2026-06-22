-- Per-ticket branch automation (coo:16): the branch a ticket is currently
-- operating on. The runner writes it when it creates or starts a new cycle of a
-- branch; the REST/ticket-panel surfaces read it. Nullable + default null, so
-- existing rows are unaffected and a null value means "no branch prepared yet".
--
-- Contract: database/docs/09-database-schema-contract.md → tickets.active_branch

ALTER TABLE tickets ADD COLUMN active_branch TEXT;
