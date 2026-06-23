# 07 — Connectors & Doctor

The connector health and setup surface: which agent connectors are installed, at
what version, what's stale or broken, and the exact repair. It also hosts the
**permission-request inbox** (agents asking for tool permission). This is the web
view over `ovld setup` / `ovld doctor` and the connector tables.

**Route:** `/connectors` (workspace-scoped). Live health requires
[Group 4](../../../database/docs/10-database-table-groups.md#group-4-connector-extensions-monitoring-and-permission-ui)
(`connector_installations`, `hook_events`, `permission_requests`); without it the
page shows static setup guidance only.

---

## Layout

```
Connectors & health                                            [ Run doctor ↻ ]
┌─ Installed connectors ──────────────────────────────────────────────────────────┐
│ Agent     Status        Version   Hooks            Issues                         │
│ claude    ✓ healthy     1.2.0     follow-up ✓ perm ✓  —                            │
│ codex     ⚠ stale       1.0.3 →1.2 follow-up ✓ perm ✗  permission hook not exec    │
│ cursor    ✗ not set up   —        —                  binary not found              │
│ opencode  ○ available    —        —                  custom adapter (not installed)│
└──────────────────────────────────────────────────────────────────────────────────┘
   selecting a row → detail + exact repair command
┌─ codex · repair ────────────────────────────────────────────────────────────────┐
│ Issues:                                                                            │
│  • permission hook is not executable                                              │
│  • plugin files are one version behind (1.0.3 → 1.2.0)                            │
│ Managed files: ~/.codex/plugins/overlord, hooks, protocol rules                   │
│ Fix:   [ Copy: ovld setup codex ]   [ Copy: ovld doctor ]                          │
│ Capabilities: native-resume ✓ · model-flag ✓ · effort-flag ✓ · follow-up ✓ · perm ✓ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## Connector list

One row per supported/known agent connector. `ovld setup <agent>` /
`ovld doctor` are CLI-owned operations — the web app **reports** state and gives
the copyable repair command; it does not install connector files itself (the local
backend may offer to run setup, but the canonical path is the CLI).

| Column | Source | Notes |
| --- | --- | --- |
| Agent | connector registry | `codex`, `claude`, `cursor`, `antigravity`, `opencode`, custom |
| Status | `connector_installations` + doctor | `healthy` / `stale` / `not set up` / `available` |
| Version | installation manifest | shows current → latest when stale |
| Hooks | manifest | follow-up / permission / stop hook presence + executability |
| Issues | doctor checks | missing binary, non-executable hook, missing permission rules, stale/partial files |
| Capabilities | connector capability flags | native-resume, model-flag, effort-flag, follow-up-hook, permission-hook, context-file-prompt |

### Detail / repair panel
- Lists concrete issues and the **managed file manifest** Overlord owns for that
  agent (so the user sees what setup touches and trusts it won't clobber settings).
- The exact repair: `CopyCommand: ovld setup <agent>` (idempotent) and
  `ovld doctor`. "Run doctor" re-runs the checks and refreshes the page.
- For custom/OpenCode agents: shows the command-template/adapter config and the
  capability flags the connector declares.

---

## Custom harness extensions (Group 4)

When connector extensions are in use, a secondary section lists:

- **Personal extensions** (`user_harness_extensions`): authored custom harness
  definitions + versions for this user. Author/edit/version actions.
- **Workspace catalog** (`workspace_harness_extensions`): extensions promoted into
  the workspace, shown as version-snapshotted entries. Promote-a-version action
  (gated by RBAC). The UI makes clear that promotion snapshots a specific version so
  later personal edits don't silently change workspace behavior.

`connector_installations` is presented as **local setup/doctor state only**, never
as the source of truth for authored extension definitions.

---

## Permission-request inbox

Agents publish `permission_request` events when they need tool permission. This
inbox is the human approve/deny surface (also surfaced inline on mission detail and
in the topbar attention counter).

```
Permission requests (2)
┌──────────────────────────────────────────────────────────────────────┐
│ 1:1429 · claude  wants:  Bash  "rm -rf node_modules && npm i"   2m     │
│        objective "Write docs"                       [ Deny ] [ Approve]│
│ 1:1418 · codex   wants:  WebFetch  https://…                   8m     │
│        objective "Fix race"                         [ Deny ] [ Approve]│
└──────────────────────────────────────────────────────────────────────┘
```

- Each request shows the mission/objective, agent, the requested tool/payload
  (secret-redacted — hooks never leak secrets), and age.
- Approve/Deny resolves the `permission_requests` row and posts the result; the
  agent's hook reads the resolution. Resolved requests move to a collapsed history.
- Bulk approve/deny for low-risk patterns can be offered but defaults to per-request.

---

## Data + realtime

| Region | Read | Realtime |
| --- | --- | --- |
| Connector list/health | `GET /connectors` (`connector_installations` + doctor) → `['connectors']` | `connector_installation` deltas; "Run doctor" forces refresh |
| Extensions | `user_harness_extensions` / `workspace_harness_extensions` | extension deltas |
| Permission inbox | `permission_requests` (open) | `permission_request` insert/resolve deltas → inbox + topbar counter |
| Hook events (debug) | `hook_events` (optional, append-only) | streamed; paginated, prune-aware |

---

## States

- **Group 4 absent:** show static setup instructions only — a card per supported
  agent with `ovld setup <agent>` and a link to the connector docs; no live health,
  no permission inbox. Make clear that live health requires enabling connector
  monitoring.
- **No connectors installed:** "No connectors set up yet" + `ovld setup` /
  `ovld setup all`.
- **Binary missing:** the connector row warns and links to install docs; setup
  "should not fail hard when the agent binary is absent" — the page reflects that
  (warn, don't block).
- **No permission requests:** empty inbox, "agents will appear here when they
  request tool permission."

---

## Capability gating

- Live connector health, extensions, hook events, and the permission inbox: Group 4.
- Promoting a personal extension to the workspace catalog and approving permission
  requests are RBAC-gated (`connector:configure` and equivalent) when Group 1 is
  installed.

---

## Acceptance criteria

- The page reports each supported connector's install status, version, hook health,
  and capability flags, and gives the exact `ovld setup`/`ovld doctor` repair.
- A stale or broken connector (e.g. non-executable permission hook) is flagged with
  a copyable one-line fix.
- Permission requests from agents appear live and can be approved/denied, with the
  result reflected back to the agent and removed from the attention counter.
- With Group 4 absent, the page degrades to static setup guidance with no broken
  controls.
- The UI never claims to have installed connector files it didn't; setup remains a
  CLI/local-backend operation.
</content>
