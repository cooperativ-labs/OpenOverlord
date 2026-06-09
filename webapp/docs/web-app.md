# Web App Requirements

This file intentionally contains the web app requirements separately from the CLI/core feature plans. Overlord should get the CLI working first and can later implement this surface in a separate UI stack.

## Recommended Framework Direction

For the first implementation, prefer a **client-rendered React app built with Vite** rather than Next.js.

Recommended stack:

- Vite + React + TypeScript
- TanStack Router for route/stateful navigation
- TanStack Query for server-state caching and realtime invalidation
- Serwist via `@serwist/vite`

Why this is the best fit for the current requirements:

- SEO is explicitly not important, so SSR and React Server Components add complexity without enough product value.
- The app is primarily an operational UI, so stable client-side interactivity and fast incremental updates matter more than server-rendered first paint.
- Overlord already wants a shared service layer and explicit REST/realtime boundary; a Vite SPA maps cleanly onto that architecture.
- Serwist has a first-party Vite integration, which keeps PWA setup direct and avoids framework-specific indirection.
- Realtime ticket/session updates fit naturally into a client cache fed by SSE/WebSocket events and REST catch-up reads.

Why not make Next.js the default recommendation:

- Next.js is strongest when SSR, static generation, and server-first routing are important. Those are not the primary constraints here.
- Its full-stack conventions would blur the module boundary between the browser UI and the Overlord REST/protocol-backed service layer.
- The extra server/runtime surface would increase implementation and debugging cost for a local-first control plane.

This is a recommendation, not a hard contract commitment. If later requirements shift toward hosted deployment, SEO, or mixed server-rendered/public routes, the project can reevaluate that choice.

## Goal

The web app is the shared control center for projects, tickets, objectives, execution, and review. It should call the same local/core operations as the CLI rather than becoming a separate implementation of the workflow.

## MVP Web App Scope

The first web app should provide a local UI for:

- Project selection and project settings.
- Ticket board/list.
- Ticket creation and editing.
- Objective creation, editing, ordering, and submission.
- Manual Run requests.
- Activity timeline.
- Blocking question review.
- Delivery review.
- Artifact and attachment display.
- Local runner status.
- Connector setup status.

It should not require auth for the first local version.

## Main Views

### Projects

Requirements:

- List projects.
- Create/edit/archive projects.
- Show linked local resource directories.
- Mark a resource directory primary.
- Show missing working directory warnings.
- Expose default agent/model settings.
- Expose project workflow/status settings.

### Ticket Board

Requirements:

- Kanban-style grouped statuses.
- List view for dense review.
- Search and filters by status, project, priority, assignee/agent, and updated date.
- Drag/drop or explicit status movement.
- Create ticket modal.
- Quick run affordance for runnable objective.
- Realtime or polling updates from active sessions.
- Read/unread indicators can be deferred until multi-user support.

### Ticket Detail

Requirements:

- Header with title, status, priority, project, ticket ID, and execution target.
- Objective list with states and assigned agent/model.
- Active objective editor.
- Add objective.
- Reorder draft/future objectives.
- Attach files to a specific objective.
- Show acceptance criteria, constraints, available tools, and output format.
- Activity timeline with progress updates, follow-ups, decisions, questions, and deliveries.
- Shared context viewer.
- Artifact viewer.
- Delivery summary and rationale coverage.

### Execution Controls

Requirements:

- Manual Run button creates an execution request.
- Show queued/claimed/launching/launched/failed states.
- Show waiting-for-runner state with copyable CLI fallback.
- Select agent/model for objective before launch.
- Show local runner status.
- Clear stale execution requests.
- Auto-advance approval gate UI for objectives with `auto_advance=false`.

### Review

Requirements:

- Delivery summary visible at top of review state.
- Artifacts grouped by type.
- Human action/follow-up section.
- Change rationales grouped by objective and file.
- Objective completion history.
- Redelivery indicator for `pending_delivery`.
- Buttons/actions to complete, reopen, add follow-up objective, or ask for changes.

### Current Changes

Requirements:

- Show read-only local VCS status for linked project directory.
- Show changed file list and diff hunks grouped by ticket/objective when available.
- Link hunks to recorded change rationales where possible.
- Filter by ticket/objective.
- Show unassigned/current workspace changes when a local diff cannot be associated with a specific objective.
- Show unavailable state if no local directory is linked or the browser cannot access local diffs.

For a browser-only local web app, this may need a local backend process to read VCS state. It should not upload repository contents unless the user explicitly requests an artifact/attachment, and it must not perform VCS mutations.

### Settings

Requirements:

- Instance settings: name, database path, web port.
- CLI/connector settings: installed connectors, setup/repair commands, default agent/model.
- User token settings: create, list, rotate, rename, and revoke `USER_TOKEN` credentials without ever showing raw token secrets after creation or rotation.
- Terminal settings: default terminal/launch command.
- Execution targets: local device label and linked directories.
- Project workflow: statuses and default status.
- Danger zone: archive/delete local projects/tickets, with confirmation.

## Deferred Web App Scope

These are upstream Overlord features that should not block CLI-first Overlord:

- Marketing pages.
- Hosted auth pages.
- OAuth/device login pages.
- Passkeys.
- Organization members and invitations.
- Slack/Everhour/integration settings.
- Feed page and AI-generated feed posts.
- Mobile app routes.
- Desktop-only Electron surfaces.
- Remote SSH target management beyond displaying future core data.
- Graph/hotspot visualizations.
- Admin pages.
- Public docs site.

## Data And API Boundary Requirements

- The web app should consume the same application services used by `ovld`.
- If HTTP endpoints are added, they should mirror protocol command semantics.
- Protocol APIs should stay agent-safe and machine-readable.
- UI-only endpoints should not become the source of truth for lifecycle transitions.
- No repository contents should be read or displayed unless the local backend has an explicit linked directory and the user requested local changes/diff views.
- VCS access is read-only; the web app must not create commits, refs, branches, stashes, checkpoints, tags, resets, checkouts, patches, or any other VCS mutation.

## UX Requirements

- The first screen after launch should be the operational ticket/project UI, not a marketing page.
- Empty states should tell the user the next CLI or UI action.
- Active agent work should visibly update without requiring refresh.
- Failed launches should show the exact repair path.
- Review pages should be easier to scan than terminal logs.
- Web app should remain optional for agent execution; CLI and runner must work without it.

## Acceptance Criteria

- A user can create a project and ticket from the web app and then execute it via the CLI runner.
- A user can watch an executing objective update in the ticket detail.
- A user can review delivery summary, artifacts, and rationales from the web app.
- A user can identify and clear stale execution requests.
- A user can configure connector/default launch settings without editing config files manually.
