# Private-Network PostgreSQL Deployment Plan

## Base Use Case Assumption

This plan assumes Overlord is starting as an organization tool rather than a
single-user local CLI database:

- One authoritative database is hosted on a machine inside a private network.
- About three users access the same organization/workspace.
- Multiple clients run on different machines.
- Agent sessions and user clients may update missions, objectives, shared context,
  deliveries, and review metadata concurrently.
- Jobs in `execution_requests` are often claimed and executed by runner clients
  on different machines.
- The deployment needs shared state, coordination, auditability, and reliable
  queue claiming more than it needs zero-setup local persistence.

Given those assumptions, PostgreSQL should be the authoritative database from
the start. SQLite can still be useful later for local caches or offline drafts,
but it should not be the shared database for this topology.

## Recommendation

Use a private-network PostgreSQL database behind one or more Overlord service
processes. Clients and runners should call the protocol/REST service layer, not
write database tables directly.

```text
User clients / agent clients / runner clients
        |
        | ovld protocol / REST / runner API
        v
Overlord service process
        |
        | service-layer transactions
        v
PostgreSQL on private network
```

This keeps all domain rules in one place: authorization, idempotency,
`revision` compare-and-set, queue claiming, `mission_events`, `entity_changes`,
and audit attribution.

## Why Not Shared SQLite

SQLite is still the right default for a local, single-workstation MVP, but this
deployment crosses the important boundary:

- Many clients are on different machines.
- The database is shared organization state, not local application state.
- Queue jobs are claimed by distributed runner clients.
- Multiple agents and users can write at the same time.

Sharing a SQLite database file across machines is the wrong failure mode for
this use case. It couples correctness to filesystem locking and same-host WAL
behavior. PostgreSQL gives the deployment a network-addressable database with
row-level coordination and stronger multi-writer behavior.

## Core Architecture

### Database

PostgreSQL owns authoritative organization state:

- Workspaces, users, projects, missions, objectives, sessions, deliveries, and
  review artifacts.
- `execution_requests` queue state.
- `mission_events` history.
- `entity_changes` change feed.
- Idempotency records.
- RBAC role assignments and token metadata.

The PostgreSQL adapter must preserve the existing logical database contract. It
can use native PostgreSQL types such as `jsonb`, `boolean`, and `timestamptz`,
but public protocol and REST behavior should stay adapter-neutral.

### Service Layer

All writes should run through Overlord services. The service layer should:

- Authenticate and authorize the actor.
- Start an ACID transaction.
- Validate idempotency scope and request hash.
- Apply the domain mutation using `revision` compare-and-set where applicable.
- Append `mission_events` when the mutation affects mission history.
- Append `entity_changes` in the same transaction.
- Commit and then wake realtime subscribers.

Direct client writes to PostgreSQL should be treated as unsupported because they
bypass domain invariants.

### Clients

Clients should call service endpoints:

- `ovld protocol` for agent mission lifecycle work.
- REST endpoints for web or desktop clients.
- Runner endpoints for queue polling, claiming, launch status, and completion.
- Sync/realtime endpoints for change catch-up and UI refresh.

Clients may keep local caches, but server state is authoritative.

## Queue Claiming

Distributed runners should claim work through the service layer, backed by a
single PostgreSQL transaction.

Recommended flow:

1. Runner asks the service for work.
2. Service starts a transaction.
3. Service selects one pending `execution_requests` row with row-level locking,
   using `FOR UPDATE SKIP LOCKED` where available.
4. Service validates that the objective is still launchable.
5. Service marks the request claimed/running and records the runner/session
   attribution.
6. Service appends `mission_events` and `entity_changes`.
7. Service commits.
8. Runner receives the claimed job.

This lets several runners ask for work at the same time without double-claiming
the same request.

## Concurrency Semantics

PostgreSQL gives the deployment better primitives, but the application still
owns correctness.

Required rules:

- Mutable rows update with expected `revision`.
- A zero-row compare-and-set update is a conflict.
- Queue claims happen atomically.
- Idempotency keys protect retried protocol, hook, REST, and worker calls.
- Domain mutations, related events, change-feed rows, and outbox effects commit
  together.
- PostgreSQL locks are used to coordinate claims and hot rows, not as a
  replacement for domain-level `revision` checks.

## Change Feed And Realtime

Keep `entity_changes` as the durable source of truth. Realtime notifications
should wake clients, not replace the durable feed.

Recommended flow:

1. Service commits a mutation and associated `entity_changes` row.
2. Service emits an in-process notification, SSE/WebSocket event, or PostgreSQL
   `NOTIFY` with the latest known change hint.
3. Clients fetch `/sync/changes?after=<cursor>`.
4. API returns changes only up to an adapter-safe high-water mark.
5. Clients advance their cursor only after applying those changes.

For PostgreSQL, do not rely on a raw sequence value alone as the safe cursor if
multiple writers can commit out of sequence-allocation order. The adapter needs
a commit-safe visibility strategy, such as a serialized change-feed writer, a
safe high-water mark, or another contract-tested approach.

## Local SQLite Role

SQLite can still be useful, but only as local state:

- UI cache for recently read server data.
- Offline draft storage.
- Pending command outbox if offline write support is explicitly designed.
- Test fixture or single-user development mode.

If offline writes are added, local mutations should be stored as commands with a
client mutation ID and base `revision`, then submitted to the service on
reconnect. The service decides whether the command applies or conflicts.

## Operational Plan

Start with a small private-network deployment:

1. Run PostgreSQL on a trusted private host or managed private-network instance.
2. Run one Overlord service process close to the database.
3. Put clients and runners on the private network or behind VPN.
4. Use TLS for service access and database access where practical.
5. Configure daily backups and a tested restore path before production use.
6. Add connection pooling when client/runner count grows.
7. Monitor queue depth, claim latency, failed claims, database connections,
   transaction duration, and change-feed lag.
8. Add a second service process only after idempotency, queue claiming, and
   realtime wakeups are tested with multiple service instances.

## Implementation Priorities

1. Define a database adapter interface that hides SQLite/PostgreSQL physical
   differences.
2. Implement PostgreSQL DDL for the existing logical schema.
3. Add PostgreSQL migration tracking and deterministic seed data.
4. Implement service-layer transactions against PostgreSQL.
5. Implement atomic runner queue claiming with PostgreSQL row locks.
6. Implement commit-safe `entity_changes` visibility.
7. Add adapter conformance tests for SQLite and PostgreSQL.
8. Add operational scripts for backup, restore, migration, and health checks.

## Contract Impact

This plan does not require a contract change. It chooses PostgreSQL as the
initial adapter for a specific deployment topology while preserving the current
contract boundaries:

- Clients and runners use protocol/REST service surfaces.
- Services own domain transitions.
- The database adapter provides ACID transactions, constraints, queue claiming,
  revision compare-and-set, and commit-safe change-feed behavior.
- SQLite remains valid for local-first deployments and local cache use.
