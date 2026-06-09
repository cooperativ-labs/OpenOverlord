# 00 — Structure & Information Architecture

This is the structural foundation for the Overlord web interface. It defines
the app shell, navigation model, route map, realtime data model, design-system
foundations, capability gating, and the cross-cutting patterns (loading, empty,
error, offline) that every page document inherits. Read this before any page doc.

---

## 1. Product framing

Overlord's web app is an **operational control plane**, not a content site.
Its closest analogues are Linear, GitHub Projects, and a local ops console. The
mental model the UI must make obvious:

```
Project  ──contains──▶  Tickets  ──contain──▶  Objectives  ──map 1:1──▶  Agent Sessions
   │                       │                        │                          │
 git repo +            durable goal +          one agent pass            live attach → deliver
 resources            shared context          (ordered, stateful)        (updates, asks, artifacts)
```

The first screen after launch is the **operational ticket/project UI**, never a
marketing or login page (auth is optional and capability-gated). The home route
resolves to the active project's ticket board.

### Design tenets

1. **Mirror the workflow, not the database.** Surfaces are organized around
   Project → Ticket → Objective → Session/Review, the same units the CLI uses.
2. **Live by default.** Anything an agent is actively changing animates in place.
   A user watching an executing objective should never need to refresh.
3. **Every empty state names the next action** — a UI button or the exact `ovld`
   command — because the CLI and web app are peers.
4. **Failures show the repair path.** A failed launch shows the exact
   `ovld setup <agent>` / `ovld add-cwd` / `--working-directory` fix, not a stack
   trace.
5. **Review beats logs.** Review screens must be easier to scan than terminal
   output: structured delivery, grouped artifacts, rationale coverage.
6. **Read-only toward the repo.** The UI never mutates git and never uploads repo
   contents implicitly.

---

## 2. App shell & layout

A persistent three-region shell wraps all authenticated/operational routes.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ TOPBAR                                                                       │
│ [≡] Overlord   [Project ▾]     ⌘K Search…     ◍ Runner: idle   ⚠ 3      │  ← global status cluster
├──────────────┬────────────────────────────────────────────────────────────┤
│ SIDEBAR      │ MAIN (router outlet)                                         │
│              │                                                              │
│  ▸ Board     │   <page content — board / detail / review / settings>        │
│  ▸ Tickets   │                                                              │
│  ▸ Changes   │                                                              │
│  ▸ Runner    │                                                              │
│  ▸ Connectors│                                                              │
│  ─────────   │                                                              │
│  ▸ Search    │                                                              │
│  ▸ Settings  │                                                              │
│              │                                                              │
│  [project    │                                                              │
│   switcher]  │                                                              │
└──────────────┴────────────────────────────────────────────────────────────┘
```

- **Topbar** holds: app menu, the **project switcher**, the global search /
  command-palette trigger (`⌘K` / `Ctrl+K`), and a **global status cluster**
  showing local runner state (idle / polling / paused / offline), count of
  blocking items needing attention (asks + permission requests + failed
  launches), and connectivity to the realtime stream.
- **Sidebar** is primary navigation, scoped to the active project. Capability-gated
  items (e.g. multi-user admin) only appear when their table group is installed.
- **Main** is the router outlet. Detail views (ticket, review) open as full routes,
  not modals, so they are deep-linkable and survive reload.

The shell collapses to a single column under ~960px: the sidebar becomes a
slide-over, the topbar keeps the project switcher, search, and status cluster.

---

## 3. Navigation model & route map

Routing uses **TanStack Router** with typed params and search-param state. URL is
the source of truth for "where am I and what am I filtering," so every board
filter, selected ticket, and open tab is deep-linkable and reload-safe.

```
/                                   → redirect to /p/:activeProjectId/board
/p/:projectId/board                 → Ticket Board (kanban)        [doc 02]
/p/:projectId/board?view=list       → Ticket Board (list view)     [doc 02]
/p/:projectId/tickets/:ticketId     → Ticket Detail                [doc 03]
   …/tickets/:ticketId?tab=activity|objectives|context|artifacts|changes
   …/tickets/:ticketId/review       → Review & Delivery            [doc 05]
/p/:projectId/changes               → Current Changes               [doc 06]
   …/changes?ticketId=&objectiveId=&path=
/p/:projectId/runner                → Execution & Runner queue      [doc 04]
/p/:projectId/settings             → Project Settings              [doc 01]
/connectors                         → Connectors & Doctor           [doc 07]
/settings                           → Instance Settings             [doc 08]
/settings/users                     → Users & Roles  (gated G1)     [doc 09]
/settings/tokens                    → USER_TOKENs    (gated G1)     [doc 09]
/search?q=                          → Search results               [doc 10]
```

Notes:

- `:projectId` is part of the path so a project is always in scope; the project
  switcher rewrites the current route to the equivalent route in another project
  when possible, otherwise drops to that project's board.
- Ticket detail uses a `tab` search param rather than nested routes for its inner
  tabs so a deep link restores the exact sub-view.
- `/connectors`, `/settings`, and `/search` are workspace-scoped (not project-scoped)
  and live below the divider in the sidebar.

---

## 4. Data + realtime architecture

This is the heart of a "realtime React interface." The UI is a **read-through
cache over the REST boundary** with a **change-feed-driven invalidation layer**.

### 4.1 Boundary the UI consumes

From the [REST API Boundary](../../../database/docs/09-database-schema-contract.md#rest-api-boundary):

- `GET /projects`, `GET/POST /tickets`, `GET /tickets/:id`,
  `GET/POST /tickets/:id/objectives`, `GET /tickets/:id/events`,
  `GET /tickets/:id/context`, `GET /tickets/:id/deliveries`
- `POST /protocol/*` — endpoints mirroring `ovld protocol` (create, prompt,
  add-objectives, discuss-objective, update, ask, deliver, write-context,
  request-execution, clear-execution-requests, …)
- `GET/POST /execution-requests` — runner queue operations
- `GET /sync/changes?after=<seq>` — catch-up delta read
- `GET /realtime` — SSE/WebSocket stream backed by `entity_changes`

DTOs use the **camelCase logical field names** from the schema. The UI never
talks to tables directly and never owns a lifecycle transition.

**UI-implied reads to formalize.** A few reads these designs depend on are not yet
enumerated in the documented REST API Boundary and should be added to it (they are
owned by the `rest` module and fit the existing boundary — they expose domain
resources, not raw tables):

- `GET /tickets/:id/changes` — `changed_files` + `change_rationales` for review/coverage
  (docs 05, 06).
- `GET /runner/status` and `GET /execution-requests?projectId=` — runner identity and
  queue (doc 04).
- `GET /capabilities` — which à-la-carte table groups / REST features are installed,
  for capability gating (§5).
- `GET /connectors` — connector install/doctor state and permission-request inbox
  (doc 07, gated Group 4).

These should be ratified in the [REST API Boundary](../../../database/docs/09-database-schema-contract.md#rest-api-boundary)
when the web app is implemented; this UI spec treats them as the intended boundary,
not as undeclared surface.

### 4.2 TanStack Query cache shape

Query keys mirror the resource hierarchy so invalidation is precise:

```
['projects']
['project', projectId]
['tickets', projectId, filtersHash]          // board / list
['ticket', ticketId]                          // header + objectives + status
['ticket', ticketId, 'events']                // activity timeline (append-only)
['ticket', ticketId, 'context']               // shared context entries
['ticket', ticketId, 'deliveries']            // delivery + artifacts + rationales
['ticket', ticketId, 'changes']               // changed_files + coverage
['executionRequests', projectId]              // runner queue
['runner', 'status']                          // local device + queue summary
['connectors']                                // doctor / installations  (gated G4)
['search', q]
```

- **Lists** are normalized by id; detail fetches hydrate the same entities.
- **Mutations** (create ticket, add objective, request execution, ask, deliver…)
  POST to `/protocol/*` and, on success, the server returns the authoritative
  `revision` and the latest change `seq`. The mutation updates the cache and
  reconciles against the next change-feed delta.
- **Optimistic UI** is allowed only for low-risk edits (objective text/title/order,
  ticket title) and always reconciled against the returned revision; lifecycle
  transitions are never faked optimistically.

### 4.3 Realtime invalidation loop

```
 1. Open app → fetch needed lists/details via REST (each carries its entity revision)
 2. Open one /realtime connection for the active workspace
 3. Server pushes compact entity_changes rows: {entityType, entityId, ticketId,
    projectId, objectiveId, operation, entityRevision, changedFields, seq}
 4. Client maps each change → affected query keys → invalidate / patch
       ticket update   → ['ticket', ticketId] + ['tickets', projectId, *]
       ticket_event    → ['ticket', ticketId, 'events'] (append)
       objective update→ ['ticket', ticketId]
       execution_request → ['executionRequests', projectId] + ['runner','status']
       delivery        → ['ticket', ticketId, 'deliveries'] + status badge
 5. Track the max applied seq. On reconnect, call /sync/changes?after=<seq>
    to replay missed deltas. If after < minimumRetainedSeq → full resync (refetch).
```

Implementation constraints from the schema contract:

- The change feed is **secret-redacted** (no token/session hashes, no file
  contents, no diffs) — safe to stream to the browser.
- SQLite installs back `/realtime` with WAL + a short poll loop; Postgres can
  additionally `NOTIFY`. Either way the client contract is identical: deltas by
  monotonic `seq`. The UI is adapter-agnostic.
- A persistent cursor (resume from last `seq`) requires
  [Group 6 `sync_clients`/`sync_cursors`](../../../database/docs/10-database-table-groups.md#group-6-persistent-realtime-client-registry).
  When Group 6 is absent the UI falls back to stateless polling of `/sync/changes`;
  behavior is the same, only cursor durability across restarts is lost.

### 4.4 Connection status & degraded modes

The topbar status cluster shows the realtime link state:

- **Live** — stream connected, deltas flowing.
- **Catching up** — replaying `/sync/changes` after reconnect.
- **Polling** — stream unavailable; falling back to interval `/sync/changes`.
- **Offline** — no backend; Serwist app shell still loads, cached reads shown
  read-only with a "stale" banner, all mutations disabled with a clear message.

---

## 5. Capability gating

Overlord is modular: a solo CLI user runs **core only**; teams and hosted
deployments add à-la-carte groups. The UI must **detect installed capabilities**
(via a `GET /capabilities` describing installed groups / REST features) and
adapt. Default to hiding rather than disabling surfaces a deployment cannot serve.

| Capability source | Gates these UI surfaces | When absent |
| --- | --- | --- |
| Group 1 — auth/tokens (`user_tokens`, `role_assignments`) | `/settings/users`, `/settings/tokens`, assignee pickers, actor attribution | Single implicit user; hide users/roles/tokens nav; show "you" everywhere |
| Group 2 — audit (`audit_log`) | Audit timeline in admin | Hide audit views |
| Group 4 — connector monitoring (`connector_installations`, `hook_events`, `permission_requests`) | `/connectors` health, permission-request inbox | Show static connector setup instructions only; no live health |
| Group 5 — tagging (`*_tag_*`) | Tag chips, tag filter on board | Hide tag UI (status + priority filters remain) |
| Group 6 — client registry | Durable realtime cursor resume | Fall back to stateless polling |
| Group 8 — search (`search_documents`) | Ranked full-text search in `⌘K` and `/search` | Degrade to exact `display_id` lookup + client-side filter |

Gating rules:

- A gated nav item is **hidden**, not shown-then-denied.
- A gated action embedded in an otherwise-available page (e.g. "assign to user")
  is hidden and the field shows the implicit single user.
- Authorization denials (RBAC) are distinct from capability gating: a permitted-but-
  forbidden action shows a machine-readable denial reason (RBAC returns these), not
  a generic error.

---

## 6. Design system foundations

### 6.1 Visual language

- **Density-first.** This is an ops tool; default to a compact, information-dense
  layout with a comfortable-density toggle in settings.
- **Dark and light themes**, dark default for an ops console. Theme is a
  CSS-variable token set; no per-component theming.
- **Monospace** for IDs (`1:1204`), file paths, hunk headers, commands, and code.
- **Color is semantic, never decorative.** A status color (below) means one thing
  everywhere.

### 6.2 Status & state color tokens

Statuses come straight from the closed vocabularies in the contract; the UI must
not invent new status words.

| Token | Applies to | Vocabulary values |
| --- | --- | --- |
| `status.draft` (neutral/slate) | ticket status, objective `draft`/`future` | `draft`, `next-up` |
| `status.execute` (blue, animated when live) | ticket `execute`, objective `launching`/`executing` | `execute` |
| `status.review` (amber) | ticket `review`, objective `pending_delivery` | `review` |
| `status.complete` (green) | ticket `complete`, objective `complete` | `complete` |
| `status.blocked` (red) | ticket `blocked`, asks, failed launches | `blocked` |
| `status.cancelled` (muted) | ticket `cancelled`, `expired`/`cleared` requests | `cancelled` |

Objective state and ticket status are **rendered distinctly** (objective = small
inline pill on the objective row; ticket status = board column / header badge),
because the contract separates the two vocabularies.

### 6.3 Core reusable components

These are referenced by name across page docs:

- `StatusBadge`, `ObjectiveStatePill`, `PriorityTag`, `TagChip` (gated G5)
- `TicketCard` (board) / `TicketRow` (list)
- `ObjectiveRow` + `ObjectiveEditor`
- `ActivityTimeline` + `EventItem` (one renderer per `ticket_events.type`)
- `AgentSessionStrip` (live session: agent, model, phase, last heartbeat age)
- `RunControl` (agent + model + effort picker → request-execution)
- `ExecutionRequestRow` (queued/claimed/launching/launched/failed)
- `DeliverySummary`, `ArtifactCard`, `RationaleCoverage`, `ChangedFileRow`
- `DiffView` (read-only, hunk-annotated)
- `ContextEntry` (shared-context key/value/tags)
- `EmptyState` (icon + sentence + primary action + CLI hint)
- `CopyCommand` (renders an `ovld …` command with copy button)
- `Toast` / `BlockingBanner` (asks, permission requests, failures)

### 6.4 Live-ness affordances

Because realtime is the headline feature, "this is live" must be legible:

- A subtle **pulse** on the `status.execute` badge while an objective is `executing`.
- `AgentSessionStrip` shows a **relative heartbeat age** ("updated 4s ago") that
  ticks; it goes stale (amber) past a threshold and offers the failure/clear path.
- New timeline events **slide in** at the top with a brief highlight; the timeline
  never reorders existing events (append-only).
- Counters in the status cluster animate on change so attention items are noticed.

---

## 7. Cross-cutting UI states (inherited by every page)

Every page document assumes these patterns rather than re-specifying them.

### Loading
- **Skeletons** that match final layout (card grid, timeline rows), never spinners
  for primary content. Detail headers load first (cheap), bodies stream in.

### Empty
- `EmptyState` with: what this is, the **primary action**, and the **CLI hint**.
  Examples: no projects → "Create a project" + `ovld create-project`; no tickets →
  "Create a ticket" + `ovld create "<objective>"`; empty queue → "Nothing queued"
  + `ovld runner status`.

### Error
- Inline, scoped to the failed region (not a whole-page takeover). Include the
  **actionable fix** the API returned and a retry. `409` conflict (revision
  mismatch) auto-refetches and re-applies where safe, otherwise shows
  "changed elsewhere — reload."

### Offline / backend-down
- App shell loads from Serwist cache. Reads show last-known data with a "stale"
  banner; mutations are disabled with "reconnect to act." Re-enables automatically
  when `/realtime` recovers.

### Permission-denied (RBAC, gated G1)
- Forbidden actions render disabled with the returned denial reason on hover/focus;
  truly out-of-scope sections are hidden per §5.

---

## 8. Accessibility, keyboard & PWA

- **Keyboard-first.** Global `⌘K` palette (doc 10); `j/k` to move between board
  cards / timeline items; `Enter` opens; `c` creates a ticket; `r` runs the
  focused runnable objective; `?` shows shortcuts. All actions reachable without a
  pointer.
- **Focus & SR semantics.** Live regions announce new asks / failed launches /
  delivery-ready. Status is never conveyed by color alone — pair with label/icon.
- **Contrast** meets WCAG AA in both themes.
- **PWA via Serwist.** Installable app shell, cached static assets, background
  update flow. Offline behavior per §7. The service worker caches the shell and
  GET reads, never POST mutations.

---

## 9. What this structure deliberately excludes

Consistent with the [web-app requirements](../web-app.md) "Deferred" list, the IA
reserves no primary navigation for: marketing pages, hosted auth/OAuth/passkey
pages, org members/invitations beyond local users, Slack/Everhour integrations,
the Feed, mobile-only routes, Electron-only surfaces, remote/SSH target management
beyond display, graph/hotspot visualizations, admin-of-admins, and a public docs
site. These can attach later behind capability gates without reshaping the core IA.

---

## 10. Acceptance criteria for the structure

- Launching the web app lands on the active project's board, never a marketing or
  forced-login page.
- Every route in §3 is deep-linkable and restores its filter/tab state on reload.
- An objective moving `submitted → executing → complete` updates the board card,
  ticket header, and timeline **without a manual refresh**, driven by `entity_changes`.
- Dropping and restoring the network re-syncs via `/sync/changes?after=<seq>` and
  shows the correct Live/Catching-up/Polling/Offline state throughout.
- Running the same install with only **core** table groups hides every gated
  surface (users, tokens, tags, connector health, full-text search) with no broken
  links, and the core workflow remains fully usable.
- No screen performs or offers a git mutation, and no repository content is sent to
  the backend except an explicit user attachment.
</content>
