# Web App Module — Agent Extension Guide

This file tells agents how to extend the Web App module to add new capabilities for users. The Web App module covers the **REST API Layer** (`rest`) in the contract. Read [`CONTRACT.md`](../CONTRACT.md) and the [component-contract skill](../.claude/skills/component-contract/SKILL.md) before making any cross-module change.

> **Status note:** A first realtime slice has landed — projects/missions/objectives CRUD with live updates. It lives in `server/` (Express REST + SSE realtime over `better-sqlite3`), `web/` (the React SPA), and `shared/` (the typed DTO contract). The remaining surfaces are still deferred; this guide describes the intended patterns so they land consistently.
>
> **Temporary deviation:** some landed `server/` paths still read/write SQLite tables directly instead of going through the shared service layer in `packages/core/service/`. The rule below (REST handlers call the service layer, never tables directly) still holds — move direct-table writers onto the shared service layer as those areas are touched. Do not add new direct-table writers without recording the same caveat.

---

## What "extending the web app" means

Extensions in this module fall into three categories:

| Extension type | Example user request |
| --- | --- |
| New REST endpoint | "Add `GET /api/missions/:id/artifacts`" |
| New realtime event | "Push mission-status changes over SSE" |
| REST extension module | "Add a namespaced `/ext/myapp/` endpoint set" |

Each type has a different procedure below.

---

## Before You Start

1. Read `CONTRACT.md` — REST API Layer section (stable id: `rest`).
2. Read the "REST API Boundary" section of [`database/docs/09-database-schema-contract.md`](../database/docs/09-database-schema-contract.md) — it defines the DTO shape contract (camelCase field names derived from the logical schema).
3. Read [`webapp/docs/web-app.md`](docs/web-app.md) for deferred UI requirements.
4. Confirm the endpoint follows the shared **service layer** pattern: REST handlers must never write to database tables directly — they call the same service layer as the CLI and protocol surfaces.

---

## Adding a New REST Endpoint

REST endpoints are stable interfaces. URL paths and HTTP method contracts, once shipped, require a contract update to change.

**Steps:**

1. **Confirm the DTO shape** against `database/docs/09-database-schema-contract.md`. Response field names are camelCase versions of the logical schema column names.
2. **Update `CONTRACT.md`** REST API Layer section with the new path, method, and response shape.
3. **Increment the contract version** in `contract/components.yaml` if the new endpoint changes a previously-stable response schema or removes/renames an existing path.
4. **Implement in `webapp/<area>/`**: one file per resource area (e.g. `webapp/missions/routes.ts`). Follow the colocated pattern: `webapp/<area>/routes.ts` + `webapp/<area>/routes.test.ts`.
5. **Auth before service call**: validate the request token via the Auth Layer, resolve the `Actor`, then call `can(actor, action, resource)` before any mutation.
6. **Reach persistence only through the service layer** — the same service functions used by `cli/` and `cli/protocol/`.
7. **Idempotency**: write-operations that can be retried (e.g. from a client retry on timeout) must use REST-scope idempotency keys in `idempotency_keys`.
8. **Write integration tests** that cover auth failure, happy path, and conflict (409) cases.

---

## Adding a New Realtime Event (SSE/WebSocket)

The SSE/WebSocket realtime endpoint is owned by the REST API Layer. New event types are additions to the open vocabulary.

**Steps:**

1. **Define the event type name** using a namespaced string if it is extension-specific (e.g. `myapp:mission.updated`), or a plain name if it is core (e.g. `mission.status_changed`).
2. **Update `database/docs/09-database-schema-contract.md`** if the event type derives from `entity_changes` — note it in the "Realtime/Sync" section.
3. **Implement the event emitter** in `webapp/realtime/`. Events must be derived from `entity_changes` rows written in the same transaction as the domain mutation — never computed separately.
4. **Document the event shape** (type, payload fields) in `CONTRACT.md` REST API Layer section.

---

## Adding a REST Extension Module

Third-party REST extensions use a namespaced endpoint prefix so they cannot conflict with core routes.

**Rules:**
- All extension endpoints must be under `/ext/<name>/` (e.g. `/ext/myapp/reports`).
- Extension routes must still authenticate via the Auth Layer and call through the service layer.
- Declare the extension in a `conformance-manifest.yaml` with `componentType: rest-module`.

**Steps:**

1. **Create `webapp/ext/<name>/routes.ts`** with the namespaced route prefix.
2. **Create `webapp/ext/<name>/conformance-manifest.yaml`** declaring `componentType: rest-module` and `componentKey: <name>`.
3. **Register the extension router** in the main `webapp/` app entry point.
4. **Validate**: `ovld contract check webapp/ext/<name>/conformance-manifest.yaml`.

---

## File Placement Convention

```
webapp/
  docs/                   ← spec docs (web-app.md, ui/, implementation-plan.md)
  shared/                 ← the typed API contract (camelCase DTOs) shared by server + web
  server/                 ← the `rest` contract component (REST + realtime backend)
    db.ts                 ← better-sqlite3 connection + entity_changes writer
    repository.ts         ← per-resource reads/mutations (one place per domain)
    realtime.ts           ← SSE emitter driven by the entity_changes feed
    index.ts              ← Express app entry
    <area>/               ← (as the surface grows) one dir per resource domain
      routes.ts
      routes.test.ts
    ext/
      <name>/             ← namespaced extension routes
        routes.ts
        conformance-manifest.yaml
  web/                    ← the React SPA (pure consumer of the rest surface)
    main.tsx router.tsx lib/ components/ pages/
  AGENTS.md               ← this file
  README.md               ← architectural overview
```

The REST layer shares the service layer with `cli/` — do not duplicate business logic here. (See the temporary-deviation note above while that layer is still being built.)

---

## Cross-Module Checklist

- [ ] Read `CONTRACT.md` REST API Layer section
- [ ] DTO shapes derived from database logical schema (camelCase field names)
- [ ] New path/method → update `CONTRACT.md` REST API Layer section
- [ ] Breaking response change → bump contract version in `contract/components.yaml`
- [ ] Auth: resolve token → Actor via Auth Layer before any service call
- [ ] Persistence: service layer only, never direct table writes from route handlers
- [ ] Write-operations: use idempotency keys for client-retry safety
- [ ] REST extension → namespaced `/ext/<name>/` prefix + conformance manifest
