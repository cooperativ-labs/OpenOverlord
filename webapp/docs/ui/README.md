# OpenOverlord Web Interface — UI Design Documents

This directory is the detailed design specification for the OpenOverlord web
control center: the **realtime React interface** that sits on top of the REST +
realtime boundary owned by the [webapp module](../../README.md) (contract
component `rest`).

These documents describe the **ideal** UI in detail. They are design specs, not
implementation. They assume the stack already recommended for this module —
**Vite + React + TypeScript + TanStack Router + TanStack Query + Serwist** (see
[framework-recommendation.md](../framework-recommendation.md)) — and they map
every screen, component, and action back to a real OpenOverlord capability
defined in the module specs and the [schema contract](../../../database/docs/09-database-schema-contract.md).

## How to read this set

Start with the structure document, then read the page documents in order. Each
page document is self-contained and follows the same template (purpose, route,
layout wireframe, components, data + realtime sources, states, actions, capability
gating, acceptance criteria).

| # | Document | What it covers |
| --- | --- | --- |
| 00 | [Structure & Information Architecture](00-structure-and-information-architecture.md) | App shell, navigation, route map, realtime model, design system, capability gating, cross-cutting patterns |
| 01 | [Projects & Project Settings](01-projects-and-project-settings.md) | Project switcher, project list, project settings, resource directories |
| 02 | [Ticket Board](02-ticket-board.md) | Kanban + list board, filters, search, create-ticket, quick run |
| 03 | [Ticket Detail](03-ticket-detail.md) | The core screen: header, objectives, editor, activity timeline, context, artifacts |
| 04 | [Execution & Runner](04-execution-and-runner.md) | Run controls, execution-request queue, runner status, approval gates |
| 05 | [Review & Delivery](05-review-and-delivery.md) | Delivery summary, artifacts, change-rationale coverage, review actions |
| 06 | [Current Changes](06-current-changes.md) | Read-only VCS status, diffs, rationale linking |
| 07 | [Connectors & Doctor](07-connectors-and-doctor.md) | Connector install/health, `doctor` results, permission-request review |
| 08 | [Settings](08-settings.md) | Instance, execution targets, project workflow, terminal, danger zone |
| 09 | [Users, Roles & Tokens](09-users-roles-and-tokens.md) | Multi-user admin, RBAC roles, `USER_TOKEN` lifecycle (capability-gated) |
| 10 | [Search & Command Palette](10-search-and-command-palette.md) | Global search, command palette, keyboard navigation |

## Scope boundaries that shape every page

These constraints come from the contract and module specs and are repeated here
because they constrain every screen below:

- **The UI is a peer of the CLI, not the source of truth.** Every lifecycle
  transition runs through the same service layer as `ovld`. The web app calls
  REST endpoints that mirror `ovld protocol`; it never owns state transitions.
- **Realtime is driven by `entity_changes`.** The UI subscribes to `/realtime`
  (SSE/WebSocket backed by the change feed) and catches up via `/sync/changes?after=<seq>`.
  Active agent work must update on screen without a manual refresh.
- **VCS access is strictly read-only.** The UI may display status, diffs, and
  rationale coverage, but it must never create commits, branches, resets, or any
  other VCS mutation, and it must not upload repository contents unless the user
  explicitly attaches a file.
- **Capability gating is first-class.** OpenOverlord installs in
  [core + à-la-carte table groups](../../../database/docs/10-database-table-groups.md).
  Pages and panels that depend on a group (auth, tags, search, connector
  monitoring) must degrade gracefully when that group is absent.
- **No secrets in the UI.** Raw `USER_TOKEN` and session-key secrets are shown
  exactly once at creation and never re-displayed; the change feed and DTOs are
  already secret-redacted.

## Source material

These designs were derived from the OpenOverlord specs current in the repo:
the root [README](../../../README.md) and [CONTRACT](../../../CONTRACT.md);
the CLI/protocol/runner/review specs under [`cli/docs/`](../../../cli/docs/);
the connector spec under [`connectors/docs/`](../../../connectors/docs/);
the auth/RBAC specs under [`auth/docs/`](../../../auth/docs/);
the [schema contract](../../../database/docs/09-database-schema-contract.md) and
[table groups](../../../database/docs/10-database-table-groups.md);
and the existing [web-app requirements](../web-app.md).
</content>
</invoke>
