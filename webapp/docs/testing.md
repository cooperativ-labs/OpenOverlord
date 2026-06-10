# Webapp + API Module — Test Plan

Part of the [master test plan](../../TEST_PLAN.md). Covers the `rest` contract
component (the REST/realtime API) and the deferred web UI that consumes it.
Normative sources: the **REST API Boundary** and **Realtime Strategy** sections of
[`09-database-schema-contract.md`](../../database/docs/09-database-schema-contract.md)
and [web-app.md](web-app.md) + the UI specs under [`ui/`](ui/).

> **Status:** the webapp is deferred (Phase 5) and may not use Next.js
> ([framework-recommendation.md](framework-recommendation.md)). This plan splits
> into an **API section** (the `rest` contract component — testable as soon as the
> REST server exists) and a **UI section** (framework-agnostic, lands with the web
> app). The objective lists "API" and "Webapp" separately, so they are kept as
> distinct sections here.

The REST API reaches persistence through the **same service layer** as CLI and
protocol, after an auth check. Its conformance tests therefore reuse the service
-layer behavior already proven at L2 and focus on the HTTP boundary: routing,
DTO shape, auth/authorization, idempotency, and realtime.

---

# Part 1 — REST API (`rest`)

## A. Resource Routing and Methods
> Boundary: `/projects`, `/tickets`, `/tickets/:id/objectives`,
> `/tickets/:id/events`, `/tickets/:id/context`, `/tickets/:id/deliveries`,
> `/protocol/*`, `/execution-requests`, `/sync/changes?after=`, `/realtime`.

- Each documented path + HTTP method exists and returns the documented status
  codes; undocumented methods on a path return `405`.
- The API exposes **domain resources and protocol commands, not raw tables**
  (contract: REST "should expose domain resources... not raw tables") — a test
  asserts there is no generic `/tables/:name` style escape hatch.
- `/protocol/*` endpoints mirror `ovld protocol` operations one-for-one
  (cross-checked with `drift-review`): every protocol command in
  [`protocol-commands.yaml`](../../contract/protocol-commands.yaml) has a REST
  counterpart and vice versa, with matching required parameters.

## B. DTO Shape (camelCase logical fields)
> Contract `rest`: "request/response DTO shapes derived from the logical schema's
> camelCase field names."

- Response bodies use camelCase logical field names from the schema contract — a
  test compares a sample of response keys against the logical field names and
  fails on snake_case leakage or raw column names.
- Responses include entity `revision` and the latest change `seq` where the
  contract recommends ("Return entity revisions and the latest change `seq` when
  useful").

## C. Auth + Authorization (restApiToDatabase surface)
> "Authenticate to a user/token/session identity. Authorize by domain permission."

- Every mutating endpoint requires authentication; an unauthenticated request gets
  `401`.
- Authorization is by **domain permission** via the Auth Layer (shared with
  [auth tests](../../auth/docs/testing.md)); a permitted role succeeds, an
  unpermitted role gets `403` with a domain-capability reason (not a table name).
- The auth check happens **before** any service-layer call (no partial writes on a
  rejected request) — asserted by confirming no `entity_changes` row on a `403`.

## D. Service-Layer + Transaction Boundary (shared with Layer 3 §3.3)
- REST handlers reach the DB **only** through the service layer — the boundary
  scan test covers REST source for raw table writes.
- State transitions run in transactions; `ticket_events` + `entity_changes` are
  appended in the same transaction (reuses [DB §4](../../database/docs/testing.md#4-change-feed-adapter-suite-4)).

## E. Idempotency
> "Use `idempotency_keys` for retried writes."

- A retried POST with the same REST-scope idempotency key returns the first result
  and does not double-apply (e.g. no duplicate ticket).
- Concurrent identical requests resolve to one applied write.

## F. Realtime + Sync
> Realtime Strategy + `/sync/changes` + `/realtime`.

- `/sync/changes?after=<seq>` returns only changes after the cursor, in `seq`
  order, with no gaps (commit-safe; reuses [DB §4](../../database/docs/testing.md#4-change-feed-adapter-suite-4)).
- `/realtime` (SSE/WebSocket) delivers a notification after a write commits and
  not before; a subscriber that reconnects with its last `seq` catches up via
  `/sync/changes` with no missed or duplicated change.
- Works on both adapters: SQLite (WAL + poll/notify) and Postgres (`NOTIFY`).

## G. REST Extension Conformance (extension point)
For a `rest-module` extension (per
[`extension-points.yaml`](../../contract/extension-points.yaml) `restExtension`):

- All endpoints are under `/ext/<name>/` (manifest `endpointPrefix` matches
  `^/ext/[a-z][a-z0-9/_-]*$`); an endpoint outside the prefix fails the manifest
  conformance test.
- The extension does not shadow a core path; uses the service layer
  (`usesServiceLayer: true`) and the Auth Layer.

---

# Part 2 — Web UI (consumer of `rest`)

The UI is a REST consumer; its correctness is bounded by the API contract above.
These tests land with the web app and are framework-agnostic.

## H. API Client Contract
- The UI talks to the API only through the documented REST endpoints (no direct DB
  access, no undocumented endpoints) — a fetch/route inventory test cross-checks
  the client against the REST route list (drift-review style).
- The client handles `revision` for optimistic concurrency and `seq` for realtime
  catch-up exactly as the API returns them.

## I. Information Architecture (per `ui/` specs)
- The route map matches [`ui/00-structure-and-information-architecture.md`](ui/00-structure-and-information-architecture.md):
  projects/settings, ticket board, ticket detail, execution/runner, review/delivery,
  current changes, connectors/doctor, settings, users/roles/tokens, search/command
  palette.
- Component-level behavior tests for each surface assert it renders the documented
  states (e.g. ticket board columns map to `project_statuses`; token UI never
  displays a raw secret after creation — mirrors the [auth security boundary](../../auth/docs/testing.md#b-tokens-srcauthtoken--l1--l2)).

## J. Realtime UI
- A change pushed via `/realtime` updates the relevant view; a dropped connection
  recovers via `/sync/changes` without a full reload or duplicated rows.

## Test Layout

```
webapp/
  test/
    api/
      routing.test.ts        # A
      dto-shape.test.ts      # B
      authz.test.ts          # C
      service-boundary.test.ts # D (shared w/ conformance)
      idempotency.test.ts    # E
      realtime-sync.test.ts  # F
      rest-extension.test.ts # G
    ui/
      api-client.test.ts     # H
      routes.test.ts         # I
      realtime.test.ts       # J
```
