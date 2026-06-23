# 08 — Settings (Instance)

Workspace-wide configuration: instance identity, default agent/model, terminal and
launch preferences, execution targets, project-workflow defaults, capability/table-
group status, and the danger zone. This is the web view over `overlord.toml` and
instance-level config. Project-scoped settings live in [doc 01](01-projects-and-project-settings.md);
users/roles/tokens live in [doc 09](09-users-roles-and-tokens.md).

**Route:** `/settings` with sub-tabs. `/settings/users` and `/settings/tokens` are
gated (doc 09).

```
Settings
[ Instance ] [ Launch defaults ] [ Execution targets ] [ Workflow ] [ Capabilities ] [ Users ▸G1 ] [ Tokens ▸G1 ]
```

---

## Instance

```
┌─ Instance ──────────────────────────────────────────────────────────────┐
│ Name           [ Open0 ]                  (overlord.toml: instance name)  │
│ Database path  /Users/jake/.ovld/open0.db   (read-only, copy)            │
│ Web port       [ 8010 ]                    (ovld serve default)          │
│ Theme          (•) Dark  ( ) Light  ( ) System                           │
│ Density        (•) Compact  ( ) Comfortable                              │
└──────────────────────────────────────────────────────────────────────────┘
```

- Instance **name**, **database path** (read-only display), and **web port** map to
  `overlord.toml`. Writes go through the local backend's config service, not direct
  file edits by the browser.
- Theme/density are client UI preferences (persisted per `project_user_preferences`
  / local storage).

---

## Launch defaults

```
┌─ Default agent & model ─────────────────────────────────────────────────┐
│ Default agent  [ claude ▾ ]   Default model [ opus ▾ ]  Effort [ high ▾ ] │
│ These seed the Run control and new-project defaults.                     │
└──────────────────────────────────────────────────────────────────────────┘
┌─ Terminal / launch ─────────────────────────────────────────────────────┐
│ Terminal command  [ $TERMINAL -e ]   ( commented presets available )     │
│ Pre-command       [ (optional wrapper, e.g. container/remote helper) ]   │
│ Poll interval     [ 3000 ms ]  (runner default)                          │
└──────────────────────────────────────────────────────────────────────────┘
```

- Default agent/model/effort, terminal launch command (with commented presets for
  popular terminals, mirroring `overlord.toml`), optional `--pre-command` wrapper,
  and runner poll interval default.

---

## Execution targets

```
┌─ Execution targets ─────────────────────────────────────────────────────┐
│ Target     Type    Device fp   Directories                Default        │
│ this-mac   local   7f2a…       ~/dev/Overlord ●prim    ●              │
│ (remote-ssh targets: display-only, future)                               │
│   [ Rename label ]   linked dirs managed per project (doc 01)            │
└──────────────────────────────────────────────────────────────────────────┘
```

- Lists `execution_targets` / `devices` for the workspace: local device label
  (editable → `update-device`), fingerprint, and linked project resource
  directories. Remote/SSH targets are **display-only** in this phase (per the runner
  spec deferral) — shown read-only when present in core data, not manageable yet.

---

## Workflow

- Workspace-level default `project_statuses` template (statuses are kept by
  workspace per the schema contract). Same editor and invariants as the per-project
  workflow section (doc 01): rename names, fix types, exactly one default / one
  `execute` / one `review`.

---

## Capabilities (table groups)

```
┌─ Installed capabilities ────────────────────────────────────────────────┐
│ ✓ Core                        always                                       │
│ ✓ Group 1  Auth & tokens      users, roles, USER_TOKENs enabled           │
│ ✗ Group 2  Audit trail        not installed   [ how to add ]              │
│ ✓ Group 4  Connector monitor  connector health + permission UI            │
│ ✗ Group 5  Tagging            not installed   [ how to add ]              │
│ ✓ Group 6  Realtime registry  durable cursor resume                       │
│ ✗ Group 8  Search             exact lookup only · [ how to add ]          │
└──────────────────────────────────────────────────────────────────────────┘
```

- A read-only (or admin-guided) view of which [à-la-carte table groups](../../../database/docs/10-database-table-groups.md)
  are installed, mapping each to the UI surfaces it unlocks (doc 00 §5). For
  uninstalled groups, link to the additive-migration guidance. The UI does **not**
  run migrations from the browser; it explains the CLI/admin path. This panel is why
  gated nav elsewhere is "missing" — it's the single place a user learns why.

---

## Danger zone

```
┌─ Danger zone ───────────────────────────────────────────────────────────┐
│ Archive project…   (per project; soft-delete)                            │
│ Delete mission…     (soft-delete; type the mission ID to confirm)          │
│ Reset local UI prefs                                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

- Archive/delete projects and missions with **typed confirmation**; all are
  soft-deletes (`deleted_at`) via the service layer — never hard table deletes from
  the UI. Destructive actions are RBAC-gated and disabled (with the denial reason)
  for non-admins when Group 1 is installed.

---

## Data + realtime

| Region | Read/Write | Notes |
| --- | --- | --- |
| Instance/launch/terminal | local backend config service (`overlord.toml`) | browser never writes files directly |
| Execution targets | `execution_targets`/`devices` | `update-device` for label |
| Workflow | workspace `project_statuses` | service-layer writes |
| Capabilities | `GET /capabilities` | reflects installed groups |
| Danger zone | service-layer soft-deletes | confirmation required |

Config changes that affect other surfaces (default agent, statuses) propagate via
`entity_changes` so open board/detail views update.

---

## States

- **No local backend (hosted/browser-only):** config sections that require the
  local config file are read-only with "edit from the CLI: `ovld config set …`".
- **Single-user (core only):** Users/Tokens tabs hidden; danger-zone actions
  available to the implicit trusted user.

---

## Acceptance criteria

- A user can configure default agent/model, terminal/launch preferences, and the web
  port without hand-editing `overlord.toml`.
- The capabilities panel accurately reflects installed table groups and explains
  which UI surfaces each unlocks, with an additive-migration path for the rest.
- Execution-target labels are editable; remote targets, if present, are clearly
  read-only for now.
- All destructive actions require explicit confirmation and perform soft-deletes via
  the service layer.
- With no local backend, file-backed settings degrade to read-only with the
  equivalent CLI command.
</content>
