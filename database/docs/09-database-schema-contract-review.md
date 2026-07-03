# Review: Database Schema Contract (09)

A review of [`09-database-schema-contract.md`](09-database-schema-contract.md) read against the rest of the
feature plans (`01`–`08`, `web-app.md`) and the root `README.md`.

The goal of this review is the one stated on the mission: surface **issues/problems**, **improvements**,
and **feature suggestions** that make the schema both more *developer friendly* and more *extensible* for
an open-source audience.

## Overall Assessment

The contract is strong and unusually thorough for a first pass. The instincts are right:

- Logical-type abstraction over SQLite/Postgres instead of one concrete dialect.
- A single canonical change feed (`entity_changes`) as the portable basis for realtime, REST polling, and sync.
- Soft deletes + `revision` + stable string IDs as the foundation for sync and export/import.
- Append-only history (`mission_events`, `deliveries`, `audit_log`) separated from mutable domain state.
- Services-own-transitions / DB-owns-shape as the layering rule.
- A sensible first-migration slice and a "no native enums in the contract" portability stance.

The issues below are mostly about **under-specified invariants** that will become bugs once a second
writer (Postgres, REST, a runner, a web app) exists, plus **doc-vs-doc contradictions**, plus the gap
between the stated open-source/extensibility goal and what the contract actually gives extension authors.

Findings are tiered and ID'd so they can be triaged: **C** = correctness/portability (will bite),
**M** = moderate / consistency, **N** = minor / nits, **E** = extensibility, **D** = developer-friendliness.
A prioritized punch list is at the end.

---

## C — Correctness & Portability (these will bite)

### C1. `entity_changes.seq` ordering is not commit-safe under concurrent writers
`seq` is defined as "monotonic per database, primary cursor," and every poller/sync client reads
`WHERE seq > cursor ORDER BY seq`. This is correct for single-writer SQLite, but **breaks on Postgres**,
which the contract designates a first-class adapter:

- A sequence/identity value is assigned at *insert* time, but transactions become *visible* at *commit*
  time. Transaction A can take `seq=5` and commit *after* transaction B takes `seq=6` and commits.
- A poller that reads at the instant B is committed but A is not sees `seq=6`, advances its cursor past 5,
  and **permanently loses change 5**. This is the classic change-data-capture gap problem.

Recommendation: state an explicit visibility contract. Options to document:
- A "safe high-water mark": consumers only advance past the largest *contiguous* committed `seq`, and the
  server exposes a `min_in_flight_seq` / watermark; or
- For Postgres, drive the feed from commit ordering (logical replication slot, `pg_current_snapshot()` /
  `xmin` horizon, or a transactional outbox drained by a single worker) rather than the raw sequence; or
- Keep a dedicated `change_feed_watermark` row updated by a serializing worker.

At minimum, the contract should say that **raw `seq > cursor` polling is only valid when writes are
serialized**, and specify the watermark mechanism each multi-writer adapter must provide. This is the most
important correctness item because the entire realtime/sync story depends on it.

### C2. `TimestampUTC` allows two incompatible SQLite encodings
The logical-types table lets SQLite store `TimestampUTC` as **either** ISO-8601 text **or** integer ms.
If two columns (or two adapters) pick differently, range filters, `ORDER BY updated_at`, and the
indexes built on those columns stop being portable or even internally consistent:

- ISO-8601 text sorts correctly only if every value is fixed-width, zero-padded, UTC, same fractional
  precision, with a consistent `Z` suffix.
- Epoch-ms sorts numerically and won't compare against text values.

Recommendation: pick **one** canonical SQLite representation for the whole contract (recommended:
ISO-8601 UTC, `YYYY-MM-DDTHH:MM:SS.SSSZ`, fixed precision) and make it a hard rule, not an option.
Mixed encodings are a silent portability/ordering bug generator across `updated_at`-ordered indexes
(`missions`, `objectives`, `projects`, `entity_changes`, etc.).

### C3. `role_assignments` "unique active assignment" is not actually enforced for instance-level roles
The unique index is `(workspace_id, workspace_user_id, role_key, resource_type, resource_id)` and
`resource_type`/`resource_id` are nullable (instance-level roles leave them NULL). In **both** SQLite and
Postgres, `NULL` is distinct from `NULL` for uniqueness, so:

```
(ws, wu, 'ADMIN', NULL, NULL)   -- inserted twice, three times, N times: all allowed
```

The most common case — a plain instance-level role grant — has **no uniqueness protection at all**, so
revoke/re-grant churn or a double-write produces duplicate active grants. Postgres 15's
`NULLS NOT DISTINCT` would fix it but isn't portable to SQLite.

Recommendation: use non-null sentinels (e.g., `resource_type = ''`, `resource_id = ''` for
instance scope) or a generated unique key column, so the partial unique index is real on both engines.
The same nullable-in-unique-index pattern should be audited anywhere "unique active (… optional col …)"
appears.

### C4. `deliveries.session_id` (NOT NULL) contradicts the `record-work` protocol command
`deliveries.session_id` is required, and `changed_files.session_id` is also `NOT NULL`. But the agent
protocol (`03`) and the skill both define `record-work` as creating a **review mission with a completed
objective and a delivery record for work done in chat with _no attached session_**. As specified, a
`record-work` delivery cannot be inserted.

Recommendation: either (a) make `deliveries.session_id` and `changed_files.session_id` nullable and
document that `record-work` rows have null sessions, or (b) require `record-work` to synthesize a
`agent_sessions` row of a `connection_method` like `record_work`. Pick one and state it; right now the
schema and the protocol plan disagree.

### C5. `revision` has no defined concurrency semantics
`revision` is "increment on mutation," and the local-sync section assumes "base revisions and explicit
conflict responses." But nothing requires writers to use it as an optimistic-lock token. With REST + a
runner + a web app all writing, two readers can both load `revision=4`, both write, and the second
silently clobbers the first.

Recommendation: define `revision` as a mandatory optimistic-concurrency token: updates use
`... WHERE id = ? AND revision = ?` (compare-and-set) and a mismatch is a `409`/conflict the service must
surface. Document that the bump and the `entity_changes` append happen in the same transaction. Without
this, `revision` is decorative and lost updates are possible the moment there's more than one writer.

### C6. Service-layer-only uniqueness is racy; require DB constraints where it matters
Several invariants are offered as "enforced by service logic **or** adapter partial index":
- `project_statuses`: exactly one active `execute` type and one active `review` type per project.
- `project_statuses.is_default`: one default per project.

Service-only checks are TOCTOU-racy under any concurrency (two requests both pass the "is there already
one?" check, both insert). SQLite (3.8.0+) and Postgres both support partial unique indexes, so there's
no portability reason to allow the service-only path for these.

Recommendation: make partial unique indexes **required** (not optional) for every "one active X" rule,
e.g. `UNIQUE (project_id) WHERE type='execute' AND deleted_at IS NULL`. Reserve "service-layer checks" only
for invariants no single index can express.

### C7. Concrete logical-type mismatches
- `objective_attachments.size_bytes` is `integer`. In Postgres `integer` is 32-bit (max ~2.1 GB) and will
  overflow on large files. Map it to `bigint` (logical `ChangeSeq`-style 64-bit), and the SQLite side is
  already 64-bit.
- `sync_cursors.last_seq` is typed `integer`, but it tracks `entity_changes.seq`, which is the
  `ChangeSeq`/`bigint` logical type. It should be `ChangeSeq`, otherwise a long-lived database overflows
  the cursor before the feed it points into.
- `worker_jobs`/`execution_requests`/`objectives.position` etc. counters are fine, but the contract should
  say which integer columns are 32-bit-safe and which must be 64-bit, since "integer" silently means
  different widths per engine.

---

## M — Moderate / Consistency

### M1. Lifecycle `status` values duplicate the `deleted_at` tombstone
`projects.status` includes `deleted`, `users.status` includes `removed`, `workspace_users.status` includes
`removed` — and every one of those tables *also* has `deleted_at`. Two sources of truth for "gone" will
disagree (`status='deleted'` with `deleted_at IS NULL`, or vice versa), and every query now has to check
both.

Recommendation: drop the terminal `deleted`/`removed` *status* value and let `deleted_at` be the single
tombstone. Keep `status` for non-terminal operational states only (`active`, `archived`, `disabled`).
Document the rule "soft delete = `deleted_at`, never a status value."

### M2. Tenant/denormalization invariants are unstated
Almost every table carries a denormalized `workspace_id` (and often `project_id`, `mission_id`,
`status_type`) next to an FK whose parent carries the same column. Nothing requires the denormalized value
to equal the parent's, so a bug or a malicious write can create a cross-tenant row (`missions.workspace_id`
≠ `projects.workspace_id`). For a future multi-tenant/hosted deployment this is a security boundary.

Recommendation: either mandate composite foreign keys (`(workspace_id, project_id)` → `projects
(workspace_id, id)`), which make cross-tenant references impossible at the DB level, or state an explicit
service invariant + conformance test. Same applies to the cached `missions.status_type`: state that it must
be re-derived (in the same transaction, with an `entity_changes` row) whenever the referenced
`project_statuses.type` changes, or it will drift.

### M3. Controlled vocabularies drift between documents; there's no single registry
The same conceptual enums are re-listed in several docs and already disagree:
- `execution_requests.status` in `09` is `queued/claimed/launching/launched/failed/cleared/cancelled/expired`;
  `04` lists only `queued/claimed/launching/launched/failed/cleared`.
- Default mission status **names** (`01`) include `next-up`, but the mission status **types**
  (`draft/execute/review/complete/blocked/cancelled`) have no "ready/backlog" type, so `next-up` has no
  defined `status_type` mapping. (This very mission is in `next-up`.)
- Objective `state`, mission `status_type`, protocol `phase`, `agent_sessions.phase`/`delivery_state`,
  `execution_requests.status`, and `worker_jobs.status` are all free-text controlled vocabularies scattered
  across tables.

Recommendation: add a **Controlled Vocabularies appendix** to the contract that is the single source for
every status/type/kind/phase column, its allowed values, and — where relevant — the legal transitions
(a small state-transition table for `objectives.state` and mission `status_type` especially). Resolve the
`next-up` → type mapping (either add a `ready` type or document that `next-up` is `status_type='draft'`).

### M4. Soft-delete + FK + change-feed semantics are under-specified
- On-delete behavior (cascade / restrict / set null) is never stated, and "FK enforcement is required"
  sits awkwardly next to "deletes are normally soft." If parents are soft-deleted, FK enforcement does
  little; if a parent is ever hard-deleted, children's behavior is undefined.
- Soft-deleting a parent does **not** auto-tombstone children; the contract should say whether queries
  must filter `deleted_at IS NULL` at every level and whether services cascade soft deletes.
- The change feed has `operation IN (insert, update, delete, restore)`. A sync client needs to know whether
  a `delete` is a *tombstone to keep* (soft delete) or a *purge to drop* (hard delete), and what happens to
  its cursor when rows are physically pruned.

Recommendation: document (a) the canonical on-delete policy per relationship, (b) the soft-delete cascade
rule, and (c) that `delete` in the feed = soft-delete tombstone, with purges either also emitted or
explicitly out-of-band (requiring full resync).

### M5. Conditional-required columns need CHECK constraints, not just prose
Multiple tables encode "required when…" rules that no FK/unique can enforce:
- `shared_context_entries`: `value_text` required iff `value_kind='string'`, `value_json` required iff
  `value_kind='json'`.
- `execution_targets`: `device_id` required for `type='local'`.
- `artifacts`: at least one of `content_text`/`content_json`/`external_url` (implied, not stated).

Recommendation: state that adapters express these as `CHECK` constraints (both engines support them) and
include the canonical CHECK expressions in the contract so SQLite and Postgres enforce them identically.

### M6. Three overlapping idempotency mechanisms, no layering rule
There's a generic `idempotency_keys` table, plus `mission_events.idempotency_key`, plus
`execution_requests.idempotency_key`. It's unclear when a protocol write uses which, so implementers will
either double-guard or leave gaps. Also, `idempotency_keys.request_hash` exists but the "same key, different
body" outcome isn't specified.

Recommendation: document the layering ("generic table guards the *request/response*; per-table keys guard
the *domain insert*") and the conflict rule (same key + different `request_hash` → error/`409`, never
replay the cached response).

### M7. `changed_files` per-session keying vs objective-level coverage
The upsert key is `(session_id, objective_id, file_path)`, so a re-attach / retry (a second session on the
same objective) creates a second row for the same file. Delivery coverage ("every meaningful tracked change
has a final rationale") is objective-scoped. The aggregation rule across sessions isn't stated.

Recommendation: state that delivery coverage aggregates `changed_files` across all of an objective's
sessions, and define how `current_diff_state` (`present`/`resolved`/`unavailable`) is reconciled when
multiple sessions disagree.

**Resolved (coo:127 Layer 4):** `deliverSession` (`packages/core/service/protocol.ts`) now reconciles this.
An optional `observedDirtyPaths` deliver field (the client's full current dirty-worktree snapshot) lets the
server mark any `present` row for the objective whose path is no longer dirty as `resolved` before rationale
coverage is computed, regardless of which session originally recorded it. See
`planning/feature-plans/agent-change-attribution-optimization.md` and CONTRACT.md's contract-version-2
changelog entry.

### M8. `objectives` reordering vs `UNIQUE active (mission_id, position)`
A unique constraint on `(mission_id, position)` makes naive reordering (swap two positions in two UPDATEs)
violate uniqueness mid-operation; SQLite has no easy deferred unique constraints.

Recommendation: document a safe reorder strategy — gap-based positions (100, 200, 300…), fractional/rational
positions, or a temporary-offset rewrite — so every adapter reorders the same way. Same note applies to any
other `position`/ordering column.

### M9. No retention / compaction policy for append-only tables
`mission_events`, `entity_changes`, `hook_events`, and `audit_log` grow unbounded with no `expires_at` or
documented pruning (unlike `idempotency_keys`/`outbox_messages`, which have cleanup boundaries). For a
long-lived local SQLite file this is real bloat, and pruning `entity_changes` invalidates older cursors.

Recommendation: document a retention/compaction policy and a **minimum-retained-`seq`** contract so sync
clients know when they must full-resync rather than resume from a now-pruned cursor.

### M10. `mission_sequences` scope vs the `missions` unique index disagree
`mission_sequences` defaults to `scope_type='workspace'` and the `display_id` format is `<org>:<sequence>`
(workspace-scoped). But `missions` enforces `UNIQUE (project_id, sequence_number)` — a *project*-scoped
uniqueness on a *workspace*-scoped counter. These don't line up: a workspace counter guarantees
workspace-wide uniqueness, so the meaningful index is `(workspace_id, sequence_number)`.

Recommendation: align the unique index with the chosen sequence scope (this is also Open Design Question #1
— see opinions below), and note that changing the scope later is a migration, not a config toggle.

---

## N — Minor / Nits

- **N1.** `user_tokens` stores both `predecessor_token_id` and `successor_token_id` (a doubly linked list);
  the two can disagree. Keep `predecessor_token_id` only (successor is derivable) or state the
  "maintain both in one transaction" invariant.
- **N2.** `agent_sessions.session_key_prefix` and `user_tokens.token_prefix` are unique per workspace and
  used for lookup-then-verify. Document the prefix length/entropy requirement: long enough to avoid
  collisions (a collision blocks a legitimate insert) but short enough not to leak the secret.
- **N3.** `missions.priority` is free text (`low/normal/high/urgent`) but board sort needs an order text
  can't provide. Add a documented ordinal (or a `priority_rank` column).
- **N4.** `audit_log` indexes cover workspace/actor/resource but not `action` or `result`; security queries
  ("all denied `role:assign` this week") will table-scan. Add `(workspace_id, action, created_at)` and
  consider `(result, created_at)`.
- **N5.** `search_documents` has no `content_hash`/`source_revision` (forces blind reindex) and no documented
  removal path when the source entity is tombstoned. Add an incremental-reindex hash and state that
  tombstoning the source removes/!flags the search row.
- **N6.** Attachment byte GC is unspecified: when `objective_attachments` is tombstoned, who deletes the
  bytes in `storage_backend`? Wire this through `outbox_messages` (a `delete_blob` effect) and say so.
- **N7.** The "all mutable domain tables include `created_at/updated_at/deleted_at/revision`" rule has many
  intentional exceptions (`mission_sequences`, `entity_changes`, `idempotency_keys`, `hook_events`,
  `audit_log`, `sync_cursors`, `schema_migrations`, `search_documents`, `shared_context_tags`,
  `outbox_messages`). List the exempt "append-only / operational" tables explicitly so implementers don't
  "fix" them by adding the columns.

---

## E — Extensibility (the open-source goal)

The README's stated promise is "users should be able to extend/customize the schema" and attach their own
auth. Today the only extension surface in the contract is `metadata_json`/`settings_json` blobs plus
adapter-defined string values. That's thin for the stated goal.

### E1. No story for extension-owned tables or extension migrations
`schema_migrations` is keyed `(adapter, version)` with no notion of *which component* owns a migration, so a
core migration and a plugin migration can't coexist or be ordered independently, and an extension can't ship
its own tables cleanly.

Recommendation:
- Add a `component` column to `schema_migrations` (`core`, `ext:<name>`) and make the PK
  `(adapter, component, version)`; define how component migration streams interleave.
- Reserve a table-name prefix for extensions (e.g., `ext_<plugin>_*`) so core can guarantee it won't collide
  with community tables on upgrade.
- Specify a version format that gives a total order (zero-padded `0001` or timestamped) — `version` is text
  and currently relies on undefined lexical ordering.
- State whether migrations are forward-only (probably fine) — there's no `down`/rollback concept today.

### E2. `metadata_json` extension space has no convention
"Treat `metadata_json` as namespaced extension space" is stated as a principle but with no actual
convention. Two plugins will both write a top-level `color` key and clobber each other.

Recommendation: define a namespacing rule (reverse-DNS or `x-<plugin>` key prefixes), a per-extension
`schema_version` key convention, reserved core keys, and a size guidance/limit. Optionally a small
"extension metadata registry" doc.

### E3. Document the actual extension points
Several columns are clearly meant to be extended (`entity_changes.entity_type` "domain type, not
necessarily physical table"; `artifacts.type`; `mission_events.type`; `outbox_messages.topic`;
RBAC permission names; `workspaces.kind`; `execution_targets.type`). They should be collected into one
"Extension Points" section that states which vocabularies are open vs closed, how to register custom values,
and which ones flow through the change feed/outbox so extensions can react.

### E4. "First-class Postgres / replaceable adapter" needs a published conformance suite
The contract says adapters "should include contract tests." For an open-source project where community
adapters are the whole point, ship a **shared adapter conformance suite** that any adapter (sqlite,
postgres, community) must pass: atomic queue claim, `entity_changes` appended in the same transaction,
active-unique enforcement, soft-delete filtering, optimistic-concurrency on `revision`, and the change-feed
visibility contract from C1. This is what makes "Postgres as first-class" and "replaceable auth/RBAC
provider" real rather than aspirational.

---

## D — Developer-Friendliness

### D1. Make the schema a machine-readable single source of truth
This is also the contract's own Open Design Question #4, and the answer is yes: define the schema once in a
typed/declarative form (a small schema DSL, JSON, or an established tool — Atlas / Drizzle / Prisma-style)
and **generate** the adapter DDL (SQLite + Postgres), the REST DTO field names, the contract/conformance
tests, and even this table documentation. The contract currently fights drift manually (the whole "Contract
Maintenance" section exists to remind humans to update the doc in the same PR). A generator removes the
class of problem and is the single biggest developer-friendliness win.

### D2. Add an ER diagram / FK dependency map
28 tables are described in isolation with no relationship overview. A Mermaid ER diagram (or at least an
FK-dependency list and a topological "safe create/drop order") would dramatically cut onboarding cost for
contributors and make the first-migration-slice ordering obvious.

### D3. Version the contract and add a changelog
`schema_migrations.contract_version` references "the contract version implemented," but the document has no
version number or changelog. Add `Contract Version: 0.x` at the top and a short changelog section so a
migration can reference a real version.

### D4. State the physical↔JSON naming rule once
The contract says "use canonical JSON field names even when physical columns are snake_case" but never gives
the rule. Document it explicitly: snake_case columns ↔ camelCase JSON, and `*_json` columns drop the suffix
in the public field (`metadata_json` → `metadata`). Otherwise every implementer guesses.

### D5. Add a "Default Seed" section
The first-migration slice lists tables but not the canonical seed every install needs: the well-known local
`workspaces` row (id/slug), the implicit `users` + `workspace_users` pair, the default `project_statuses`
set with their `type` mapping (this resolves the `next-up` ambiguity from M3), and the default
`ADMIN`/`MEMBER` roles. A documented seed makes "one implicit trusted user" reproducible across adapters.

### D6. Document the shapes of contracted JSON columns
Some JSON columns carry contracted structure but no schema: `available_tools_json`,
`execution_target_intent_json`, `agent_flags_json`, `launch_config_json`, `connection_json`,
`capabilities_json`. (`change_rationales.hunks_json` is the one that *is* documented, in `06`.) For each,
either point to a schema/example or mark it explicitly freeform.

### D7. Glossary of column conventions
A short "Conventions" block — what `*_json` means, what `revision` is for, what "active" means,
soft-delete rule, timestamp encoding, ID format — read once, applies to all 28 tables.

---

## Opinions On The Contract's Own Open Design Questions

1. **Workspace-scoped `1:1204` vs per-project prefix/sequence.** Keep the workspace-scoped human ID for MVP
   (it matches `<org>:<sequence>` and the runner/CLI ergonomics), but fix M10 so the unique index matches
   the counter scope. If per-project IDs are ever wanted, model it as a *new* counter scope
   (`scope_type='project'`) plus a display format change — a migration, behind the existing
   `mission_sequences.scope_type` you already reserved.
2. **Treat session keys exactly like tokens (one-time display, hash-only) from day one.** Yes. The schema
   already stores `session_key_hash`/`session_key_prefix`; making them one-time-display from the first
   implementation avoids a later security migration and keeps `agent_sessions` and `user_tokens` symmetric.
3. **How much of `project_statuses` lives in rows vs config.** Store them in rows even for the local MVP
   (with a documented default seed, D5). Config-only statuses can't be referenced by `missions.status_id`
   FK, can't carry per-project customization, and would make the board/web app a special case. Generate the
   default rows from config at `init`, then treat the rows as the source of truth.
4. **Adapter migrations directly vs a central compiler.** Central compiler / single schema definition — see
   D1. It's the higher-leverage choice for keeping SQLite and Postgres honest and for letting the community
   add adapters without hand-porting every migration.
5. **DB locks only vs external queue for hosted long-running workers.** Start with DB-based claiming
   (`FOR UPDATE SKIP LOCKED` on Postgres, the documented compare-and-set on SQLite) — it's already specified
   and keeps the local and hosted code paths identical. Defer an external queue until a concrete
   long-running-worker need appears, and when it does, drive it from `outbox_messages` rather than coupling
   the domain tables to a broker.

---

## Suggested New Sections For The Contract

To close the gaps above with the least disruption, add:

1. **Conventions & Glossary** (D7).
2. **Controlled Vocabularies** appendix incl. state-transition tables (M3).
3. **Concurrency & Consistency** — `revision` compare-and-set (C5), change-feed visibility/watermark (C1),
   tenant/denormalization invariants (M2), reorder strategy (M8).
4. **Soft Delete, FK, and Tombstone Semantics** (M4).
5. **Extension Points & Extension Migrations** (E1–E3).
6. **Adapter Conformance Suite** (E4).
7. **Default Seed** (D5).
8. **ER Diagram** (D2), **Contract Version + Changelog** (D3).

---

## Prioritized Punch List

**Fix before first Postgres adapter / any second writer:**
- C1 change-feed visibility/watermark
- C2 single canonical timestamp encoding
- C3 nullable-unique RBAC grant bug
- C4 `deliveries.session_id` vs `record-work`
- C5 `revision` optimistic concurrency
- C6 partial unique indexes for "one active X"
- C7 `size_bytes`/`last_seq` widths

**Fix before the contract is published as the open-source baseline:**
- M1 status-vs-tombstone duplication
- M3 controlled-vocabulary appendix (+ `next-up` type)
- M4 soft-delete/FK/tombstone semantics
- M2 tenant invariants / composite FKs
- E1 extension migrations & table namespacing
- D1 single machine-readable schema source
- D5 default seed, D3 contract version

**High-value, do soon:**
- M5–M10, E2–E4, D2/D4/D6/D7

**Nice-to-have:**
- N1–N7
