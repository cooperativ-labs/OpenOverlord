# Web App Module

The optional web control center (`ovld serve`, default `http://localhost:8010`)
and the REST/realtime API that backs it. OpenOverlord is CLI-first: the web app
is deferred, but the current recommended starting point is a **Vite-powered
React SPA** instead of a server-rendered React framework.

## Contract Component

Maps to the **REST API Layer** (`rest`) in [`CONTRACT.md`](../CONTRACT.md), which owns:

- URL paths and HTTP method contracts
- Request/response DTO shapes (derived from the logical schema's camelCase field names)
- REST auth integration points (via the [Auth module](../auth/README.md))
- The SSE/WebSocket realtime endpoint

It does **not** own the database schema (→ [Database module](../database/README.md))
or the protocol CLI surface (→ [CLI module](../cli/README.md)).

## Documentation

- [Web App Requirements](docs/web-app.md): deferred UI / control-center requirements, kept separate from the CLI-first implementation.
- [Framework Recommendation](docs/framework-recommendation.md): why the first implementation should prefer Vite + React + TanStack Router/Query + Serwist over Next.js.
- [UI Design Documents](docs/ui/README.md): the detailed design specification for the realtime React interface — a structure/information-architecture document followed by one detailed spec per page (projects, board, ticket detail, execution/runner, review, changes, connectors, settings, users/tokens, search).
- REST API Boundary: see the "REST API Boundary" section of [09 — Database Schema Contract](../database/docs/09-database-schema-contract.md) (owned by the [Database module](../database/README.md)).

## Status

Deferred to a later phase (see "Phase 5: Expansion" in the
[feature-plans README](../planning/feature-plans/README.md)). The REST layer
shares the **same service layer** as the CLI and protocol surfaces, so any UI
stack can sit on top of it.

## Code & Tests

No implementation yet. Colocate web/REST source and tests here when work starts.
