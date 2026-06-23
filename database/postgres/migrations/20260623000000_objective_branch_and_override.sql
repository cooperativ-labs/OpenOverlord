-- Per-objective branch + per-ticket branch override (coo:30, objective 3).
--
-- objectives.branch: the branch an objective actually ran on, written by the
-- runner at branch-prepared time (it already knows the objective's execution
-- request). Lets the ticket panel show which branch/worktree each objective
-- used, and underpins follow-on worktree reuse.
--
-- tickets.branch_override: a user-pinned branch chosen in the ticket panel when
-- the system-selected default is wrong. When set, the next launch prepares/uses
-- this branch instead of the planner's canonical name; it is cleared once a
-- branch is prepared on it (the chosen branch then lives in active_branch and
-- the planner reuses it naturally).
--
-- Both nullable + default null, so existing rows are unaffected.
--
-- Contract: database/docs/09-database-schema-contract.md → objectives.branch,
--           tickets.branch_override

ALTER TABLE objectives ADD COLUMN branch text;
ALTER TABLE tickets ADD COLUMN branch_override text;
