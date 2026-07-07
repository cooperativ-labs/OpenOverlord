-- objectives.resource_key (coo:169 phase 3)
--
-- Target-portable logical resource binding for objectives. Null means inherit
-- the project primary resource for the claiming execution target.

PRAGMA foreign_keys = ON;

ALTER TABLE objectives ADD COLUMN resource_key TEXT;
