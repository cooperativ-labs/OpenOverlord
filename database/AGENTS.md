# Database Module — Agent Extension Guide

This file tells agents how to extend the Database module to add new capabilities for users. Read [`CONTRACT.md`](../CONTRACT.md) and the [component-contract skill](../.claude/skills/component-contract/SKILL.md) before making any cross-module change.

---

## What "extending the database" means

Extensions in this module fall into four categories:

| Extension type | Example user request |
| --- | --- |
| New core table or column | "Add a `labels` column to tickets" |
| Schema extension (ext tables) | "Add custom metadata for a connector" |
| New migration | "Add indexes for a query pattern" |
| New controlled vocabulary value | "Add a new ticket status type" |

Each type has a different procedure below.

---

## Before You Start

1. Read `CONTRACT.md` — Database Layer and Extension System sections.
2. Read [`database/docs/09-database-schema-contract.md`](docs/09-database-schema-contract.md) — the authoritative column/index/FK spec.
3. Read [`database/docs/10-database-table-groups.md`](docs/10-database-table-groups.md) — which tables are core vs. optional.
4. Determine whether your change is a **core** change (requires contract update) or an **extension** (uses `ext_<name>_` namespace and needs only a conformance manifest).

---

## Adding a New Core Table or Column

Core schema changes modify the shared contract. They require a contract update before any code lands.

**Steps:**

1. **Update `database/docs/09-database-schema-contract.md`** first — add the table/column definition, including type, nullable, default, FK references, and any CHECK constraints.
2. **Update `CONTRACT.md`** Database Layer section if the change affects stable interfaces (e.g. a new column that protocol or REST responses must now include).
3. **Increment the contract version** in `contract/components.yaml` if the change is breaking (removes a NOT NULL column, renames a column, changes a type).
4. **Write the migration** as the next numbered file: `database/sqlite/migrations/<NNN>_<description>.sql`. Migration rules:
   - Enable foreign-key checks: `PRAGMA foreign_keys = ON;`
   - Use `CREATE TABLE IF NOT EXISTS` for new tables.
   - Use `ALTER TABLE … ADD COLUMN` for new columns on existing tables (SQLite does not support `ADD COLUMN NOT NULL` without a default; add a default or make nullable).
   - Do not edit applied migrations. Add a new forward-only migration for follow-up schema/data changes.
   - Do not insert a `schema_migrations` row inside the SQL file. The Node migration launcher computes the checksum and records the row after the migration commits.
5. **Seed deterministic rows** only when the data is required for the system to function (e.g. default workspace, implicit user). Use fixed UUIDs so tests can rely on them.
6. **Apply locally to verify**:
   ```sh
   sqlite3 database/.local/Overlord.sqlite < database/sqlite/migrations/<NNN>_<description>.sql
   ```

---

## Adding a Schema Extension (ext tables)

Extensions add custom tables without modifying core tables. This is the sanctioned way for connectors, auth providers, and third parties to persist data.

**Rules:**
- Table names must be prefixed `ext_<name>_` (e.g. `ext_myconnector_sessions`).
- Migration must set `schema_migrations.component = 'ext:<name>'`.
- No direct writes to core tables from extension code — use service APIs, `entity_changes`, and `outbox_messages` for side effects.
- Namespaced keys only for any values stored in `metadata_json` or `settings_json` on core tables (use reverse-DNS style: `com.mycompany.mykey`).

**Steps:**

1. **Create the migration**: `database/sqlite/migrations/<NNN>_ext_<name>_<description>.sql`.
   ```sql
   PRAGMA foreign_keys = ON;
   CREATE TABLE IF NOT EXISTS ext_myname_items (
     id TEXT PRIMARY KEY,
     ...
   );
   INSERT INTO schema_migrations (version, component, checksum, applied_at)
   VALUES ('<NNN>', 'ext:myname', '<checksum>', datetime('now'));
   ```
2. **Create a conformance manifest** at `<your-extension-root>/conformance-manifest.yaml` declaring `componentType: database-extension` and your `componentKey`.
3. **Validate**: `ovld contract check <your-extension-root>/conformance-manifest.yaml`.
4. **Declare any open vocabulary values** you add to `metadata_json` / `settings_json` in your conformance manifest.

---

## Adding a New Migration (indexes, constraints, data)

Additive migrations that do not change the public contract (new indexes, new optional columns with defaults) do not require a contract version bump, but still require a contract doc update if they affect spec-documented fields.

**Steps:**

1. Confirm the migration number is the next in sequence (`ls database/sqlite/migrations/`).
2. Write the `.sql` file following the conventions above (foreign-key pragma, `IF NOT EXISTS`, forward-only changes).
3. If the migration adds a new index that changes query semantics, document it in `database/docs/09-database-schema-contract.md`.

---

## Adding a Controlled Vocabulary Value

### Closed vocabularies (contract version bump required)

These are listed in `CONTRACT.md` under "Controlled Vocabularies → Closed." Examples: `objectives.state`, `execution_requests.status`.

**Steps:**

1. **Propose the new value** in a contract update: edit `CONTRACT.md` Controlled Vocabularies section.
2. **Increment the contract version** in `contract/components.yaml`.
3. **Add a changelog entry** to `CONTRACT.md`.
4. **Add the value** to the `CHECK` constraint in the relevant migration.
5. **Update any application code** that switches on the closed vocabulary.

### Open vocabularies (no contract version bump needed)

These are listed in `CONTRACT.md` under "Controlled Vocabularies → Open." Examples: `execution_targets.type`, `artifacts.type`.

**Steps:**

1. Add the new value in your service code or migration.
2. If promoting to a core value (i.e. all deployments should know it), add it to `database/docs/09-database-schema-contract.md` Controlled Vocabularies section.
3. If it remains extension-specific, declare it in your `conformance-manifest.yaml`.

---

## File Placement Convention

```
database/
  docs/                         ← spec docs for this module
  sqlite/
    migrations/
      001_initial_core.sql      ← core MVP tables
      002_rbac.sql              ← RBAC + token tables
      <NNN>_<description>.sql   ← next migration goes here
  AGENTS.md                     ← this file
  README.md                     ← architectural overview
```

---

## Cross-Module Checklist

- [ ] Read `CONTRACT.md` Database Layer and Extension System sections
- [ ] Core table/column change → update `database/docs/09-database-schema-contract.md` first
- [ ] Breaking schema change → bump contract version in `contract/components.yaml`
- [ ] Closed vocabulary value → contract version bump required
- [ ] Extension tables → use `ext_<name>_` prefix and `ext:<name>` component key
- [ ] Extension code → no direct writes to core tables; use service APIs / `entity_changes`
- [ ] Conformance manifest created and validated for shipped extensions
