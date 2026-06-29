# Realtime UI Sync and Native Workflow Notifications

Date: 2026-06-29
Mission: `coo:36`

## Objective

Make the desktop/webapp interface reflect database-backed workflow changes without
manual refresh, and make native workflow notifications fire from the same durable
change stream. The implementation should stay robust and light-weight: no new
broker, no client-direct database access, and no edition-specific behavior.

## Existing Cloud Plan Review

The existing cloud-related plans are directionally consistent and should not be
replaced:

- `overlord-cloud-architecture.md` establishes the central rule: Local and Cloud
  share the same REST + protocol + realtime contract. Desktop, web, CLI, and
  runners are HTTP clients of the backend; the backend and database remain the
  system of record.
- `backend-postgres-data-layer-port.md` identifies `entity_changes` as the
  portable realtime cursor and calls out that the Postgres path must poll
  `MAX(seq)` instead of SQLite `PRAGMA data_version`. It also correctly warns
  that `recordChange` must happen on the same transaction client as the domain
  mutation.
- `railway-postgres-deployment-recommendation.md` rejects Supabase Realtime and
  similar sidecars as unnecessary. Overlord already owns `entity_changes` + SSE;
  Postgres `LISTEN/NOTIFY` should only be a wakeup optimization.
- `client-checkout-bridge-unification.md` and its follow-on contract entries rely
  on SSE invalidation for remote target mutation state. That means fixing the
  existing change feed benefits both Local and Cloud checkout flows.
- Desktop remote mode in the contract already treats the Electron app as the same
  SPA client, using the runtime API base for REST and SSE. Native notifications
  should remain a renderer feature backed by the existing preload
  `showNotification` bridge, not a desktop-owned state machine.

Conclusion: the right fix is to complete and tighten the current durable
`entity_changes` -> SSE -> React Query/notification path. Adding Redis, a
database-specific realtime product, or a second desktop notification polling
loop would add moving parts without addressing the observed missing writebacks.

## Implementation Status

Status as of 2026-06-29: implemented. The durable feed holes, `changedFields`
projection, targeted client invalidation, native notification derivation, and
canonical route/catch-up surface are all present in the codebase. The native
notification classifier also handles the planned objective-completion fallback:
when an objective change includes `state` and `completed_at`, the client can
emit "Ready for review" after refetching and confirming the objective is
`complete`, even if no delivery event is present in the realtime batch.

Verification notes:

- Focused client realtime tests cover targeted invalidation and notification
  classification.
- Server catch-up/projection tests exist, but local execution currently depends
  on a working `better-sqlite3` native module.
- The webapp typecheck command requires a resolvable `tsc` binary in the webapp
  install.

## Original Gap

The contract says every service-layer mutation should append `entity_changes` in
the same transaction as the domain change. Most paths do this today, but the
workflow paths that users notice most are incomplete:

- `deliver` inserts a `mission_events.type = delivery`, updates the objective to
  `complete`, updates the session, and moves the mission to review. The mission
  status move records a mission change, but the delivered objective and delivery
  event do not get their own durable `entity_changes` rows.
- `attach` updates objective state to `executing` and inserts an agent session,
  but the durable feed only exposes the session insert. Follow-up resume already
  records an objective change and should be treated as the template. The
  notification code currently infers "Agent started" indirectly after refetching
  mission detail, which is fragile.
- `EntityChangeDto` omits `changedFields`. The server stores
  `changed_fields_json`, but the SSE payload discards it, so the client must
  over-invalidate and notification code has to fetch mission detail/events to
  classify every workflow change.
- The client invalidates all React Query caches for every change. That is
  simple, but it can mask coverage bugs and does unnecessary work as the Cloud
  feed gets busier.
- The native notification hook only notifies for objectives currently
  `executing`, plus recent `ask` and `delivery` events. A state transition such
  as `executing -> complete` without a delivery event in the realtime batch will
  not notify.
- The long-term contract names `/realtime` and `/sync/changes`, while the
  implemented endpoint is `GET /api/stream`. `webapp/README.md` already flags
  this as a deviation. We should either alias the canonical route or update the
  contract; aliasing is the lighter contract-aligned path.

## Design Principles

1. `entity_changes` remains the canonical truth for UI sync. Native
   notifications are derived from it; they are not a separate delivery system.
2. Domain mutation, mission event, and change-feed row are committed together.
   A UI refresh should never see one without the other.
3. SSE/WebSocket messages stay compact. They identify what changed and wake the
   client; clients fetch detail through normal REST queries.
4. Local and Cloud use the same implementation. Postgres-specific
   `LISTEN/NOTIFY` is optional and only wakes the same cursor poller.
5. The first implementation can keep broad invalidation as a fallback, but known
   workflow entities should invalidate targeted queries.

## Plan

### Phase 1 - Close Change-Feed Holes

Add durable `entity_changes` rows for workflow state transitions that currently
depend on indirect signals:

- In `packages/core/service/protocol.ts` `attachSession`, record an objective
  `update` change after setting `state = 'executing'`, with
  `changedFields: ['state', 'assigned_agent']` when assignment is inherited.
- In `resumeFollowUp`, keep the existing objective change and verify the revision
  is recorded consistently.
- In `deliver`, inside the same transaction that inserts the delivery event and
  completes the objective:
  - record a `mission_event` insert change for the delivery event;
  - record an `objective` update change with
    `changedFields: ['state', 'completed_at']`;
  - record an `agent_session` update change with
    `changedFields: ['delivery_state', 'phase', 'ended_at']`.
- Audit runner and REST launch paths for state changes that update objectives or
  mission events without a matching feed row. Fix only real gaps; do not add
  duplicate rows for paths already covered.

Verification:

- Add service tests that deliver an objective and assert `entity_changes`
  includes objective, delivery event, session, and mission status changes.
- Add attach/resume tests that assert objective state changes are visible in the
  feed.

### Phase 2 - Expose Compact Change Metadata

Extend `EntityChangeDto` to include:

```ts
changedFields: string[];
```

This is already stored in `entity_changes.changed_fields_json`, so no database
migration is needed. Update `webapp/server/realtime.ts` to parse and include it,
falling back to `[]` for malformed/empty values. The field is additive and lets
the client classify workflow changes without fetching every mission/event just
to inspect state.

Contract impact:

- This is an additive REST/SSE DTO field. Update `CONTRACT.md` and
  `database/docs/09-database-schema-contract.md` before implementation, or note
  that it is an additive clarification to the existing `EntityChangeDto`.

### Phase 3 - Targeted Client Invalidation

Replace unconditional `queryClient.invalidateQueries()` on every change with a
small routing helper:

- `entityType: 'objective'` with `missionId`:
  - invalidate `keys.mission(missionId)`;
  - invalidate `keys.missions(projectId)` when `projectId` exists;
  - invalidate `keys.myMissions`;
  - invalidate objective-scoped attachment/file-change queries only when
    relevant fields change.
- `entityType: 'mission'`:
  - invalidate mission detail, project mission list, My Missions, and branch
    queries when branch/status fields are present.
- `entityType: 'mission_event'`:
  - invalidate `keys.missionEvents(missionId)` and mission detail when present.
- `entityType: 'execution_request'` and `entityType: 'agent_session'`:
  - invalidate mission detail, project mission list, runner/status queries, and
    My Missions.
- For unknown entity types, missing IDs, malformed payloads, or `refresh`, keep
  the current full-cache invalidation fallback.

This keeps the first pass robust while removing most unnecessary Cloud traffic.

Verification:

- Unit-test the routing helper with representative batches.
- Browser-test the critical path: one window delivers via protocol/runner, a
  second window updates the mission detail and board without refresh.

### Phase 4 - Native Notification Derivation

Drive native workflow notifications from the same realtime batch:

- Notify "Agent started" on objective `changedFields` containing `state` when
  the refetched objective state is `executing`.
- Notify "Ready for review" on either:
  - `mission_event` insert for a `delivery` event; or
  - objective state changing to `complete` when no delivery event is available.
- Notify "Blocking question" on `mission_event` insert for `ask`.
- Notify launch failures from `execution_request` changes where status becomes
  `failed`, using mission detail/events to build the message.
- Keep the existing `notifiedKeys` dedupe, but key on durable change `seq` or
  event/objective revision rather than only timestamps.
- Do not request browser permission on every batch. Only attempt notification
  when the user has enabled notifications; on desktop, prefer
  `window.overlord.showNotification`, with browser Notification as fallback.

Verification:

- Add tests around notification classification with mocked `EntityChangeDto`
  batches and mocked REST fetches.
- Manual desktop smoke: enable notifications, launch objective, deliver, ask,
  and fail a queued request; each produces one native notification.

### Phase 5 - Route Alias And Catch-Up

Align implementation with the documented realtime surface:

- Keep `GET /api/stream` as a compatibility route.
- Add `GET /realtime` or `GET /api/realtime` only if the app's API routing
  conventions require the `/api` prefix. Prefer the contract name where the
  backend can serve it safely.
- Add `GET /sync/changes?after=<seq>` as a paginated catch-up endpoint backed by
  `entity_changes`, or explicitly schedule it as the next objective if the first
  fix must stay smaller.
- On SSE reconnect, use the last seen cursor to call catch-up before relying on
  live events. Until that endpoint lands, keep full invalidation after reconnect.

This is the only phase that may require contract text updates if we choose a
different canonical route name. The robust/light-weight recommendation is to
alias the documented route and avoid changing the contract vocabulary.

## Suggested Implementation Sequence

1. Contract/DTO prep: add `changedFields` to `EntityChangeDto`; document route
   alias decision.
2. Server feed coverage: record missing `entity_changes`; include
   `changedFields` in SSE.
3. Client sync: add invalidation routing with full-refresh fallback.
4. Notifications: rework notification classification around durable changes.
5. Catch-up route: implement `/sync/changes` and reconnect catch-up, or split
   into the next objective if the first four steps are sufficient for the
   immediate bug.

## Acceptance Criteria

- Delivering an objective in one process updates all open web/desktop clients
  from executing to complete/review without refresh.
- Starting, resuming, delivering, asking, and failed launch/request transitions
  each produce the expected `entity_changes` rows in the same transaction as the
  domain mutation.
- Native workflow notifications fire once per relevant durable change when
  enabled, in both browser and Electron desktop.
- Local SQLite and hosted/Postgres paths use the same feed and client behavior.
- SSE reconnect cannot silently miss committed changes; either catch-up is
  implemented or a full invalidation occurs after reconnect.

## Non-Goals

- Do not introduce Redis, Supabase Realtime, a message broker, or client-direct
  Postgres connections.
- Do not move notification ownership into the desktop shell. The shell only
  exposes the existing `showNotification` bridge.
- Do not build offline conflict resolution or a local client database in this
  mission.
