# Core Domain And Lifecycle

## Goal

Port the core Overlord work model into OpenOverlord so tickets, objectives, sessions, context, and review history behave consistently before any web app or auth layer exists.

## Required Concepts

### Instance

The local OpenOverlord installation. For the MVP, one local instance can act as one implicit organization/workspace.

Requirements:

- Has a human-readable name from `overlord.toml`.
- Owns the local SQLite database.
- Provides defaults for web port, default agent/model, terminal launcher, and connector locations.
- Can later support multiple users, roles, and authentication without changing the ticket/objective workflow semantics.

### User

A user is the human identity that owns tickets, creates credentials, and receives permissions once authentication is enabled. For the local MVP, OpenOverlord can use one implicit trusted user.

Requirements:

- Reserve a user concept for future auth, roles, permissions, and audit attribution.
- Support both human users and persistent service-style users for agents or runners without creating a separate identity primitive.
- Attribute created tickets, sessions, events, deliveries, and `USER_TOKEN` records to a user once auth is enabled.
- User-owned `USER_TOKEN` credentials initially inherit all current permissions of the creating user.
- Future scoped token permissions should restrict the creating user's permissions, not create a separate agent identity.
- Disabling or soft-deleting a user should also invalidate that user's effective token access.
- Future role-based access control should use default `ADMIN` and `MEMBER` roles, with only administrators able to add, remove, or change roles for other users unless a custom authorization provider says otherwise.

### Project

A project is the top-level work container and normally maps to one repository checkout.

Requirements:

- Create, list, inspect, rename, archive/delete projects.
- Store a project name, stable identifier, optional description, default agent/model settings, and workflow/status configuration.
- Link one or more local resource directories.
- Identify one primary local resource directory for each execution target in later phases.
- Support project discovery from the current working directory.
- Write local project metadata to `.overlord/project.json` when a directory is linked.
- Reserve `.overlord/tmp/` and `.overlord/logs/` for local ephemeral runtime data.

### Ticket

A ticket is the durable goal and review record.

Requirements:

- Human-readable ticket identifier such as `1:1204` can be retained for compatibility, but MVP can also support a simple local sequence.
- The default human-readable ticket sequence is workspace-scoped. If project-scoped sequences are introduced later, treat that as a schema migration rather than a config-only change.
- Fields should cover title, objective summary, status, priority, project, constraints, acceptance criteria, available tools, output format, creator, timestamps, and execution target intent.
- Tickets contain ordered objectives.
- Tickets retain activity history, delivery records, artifacts, attachments, shared context, and change rationales.
- A ticket can be agent-executable or human-only.
- Ticket content is persistent and should be treated as shared project memory.

### Objective

An objective is one agent pass inside a ticket.

Requirements:

- One objective maps to one agent session.
- Objectives are ordered.
- Each objective has instruction text, optional title, state, assigned agent, model, agent flags, attachments, auto-advance flag, and execution metadata.
- Attachments are scoped to objectives, not generic tickets.
- New objectives should be added to the same ticket when they are sequential steps toward the same goal.
- New tickets should be created when the work is a distinct feature, bug, investigation, or review goal.

Objective states to support:

- `future`: hidden or queued future work, optional for MVP but useful for planned chains.
- `draft`: editable objective not yet submitted for execution.
- `submitted`: ready for an agent or runner.
- `launching`: queued/claimed by runner before attach.
- `executing`: attached to an active agent session.
- `pending_delivery`: follow-up execution happened after a previous delivery and needs redelivery.
- `complete`: delivered and no longer active.

### Agent Session

A session is the live attachment between an agent and an objective.

Requirements:

- Created by `ovld protocol attach`, `prompt`, or `connect`.
- Stores a session key used by subsequent protocol commands.
- Tracks agent identifier, model identifier, connection method, native external session ID when available, start/end timestamps, phase, liveness heartbeat, and delivery state.
- Can record progress updates, blocking questions, permission requests, artifacts, update-time changed-file metadata, change rationales, shared context writes, and final delivery.
- Changed-file metadata is keyed by session, objective, and normalized file path so repeated progress updates can refresh the same file record without duplication.
- Attach should be idempotent enough for agent retries and re-attachments.

### Shared Context

Shared context is durable ticket memory for future sessions.

Requirements:

- Key/value entries scoped to a ticket.
- Values should accept JSON or string content.
- Optional tags.
- Read/filter by key substring and limit.
- Used for stable facts, not full transcript duplication.

### Event History

Ticket events are the durable timeline.

Required event types:

- `update`: normal progress.
- `heartbeat`: transient session liveness; does not need to appear as a ticket event.
- `user_follow_up`: verbatim human follow-up after initial ticket.
- `alert`: non-blocking warning.
- `discussion_summary`: important non-file conclusion.
- `decision`: explicit decision.
- `ask`: blocking question.
- `permission_request`: agent needs tool permission.
- `delivery`: final or follow-up delivery.
- `execution_requested`: objective queued for runner.
- `awaiting_approval`: auto-advance stopped for human approval.
- `status_change`: ticket or objective state transition.

## Ticket Status Requirements

OpenOverlord should separate ticket statuses from objective states.

Ticket status types:

- `draft`: not ready or backlog/planning.
- `execute`: active work.
- `review`: delivered or needs human review.
- `complete`: finished.
- `blocked`: blocked or waiting for human resolution.
- `cancelled`: intentionally stopped.

Default status names can start with:

- `draft`
- `next-up`
- `execute`
- `review`
- `complete`
- `blocked`
- `cancelled`

Requirements:

- `next-up` is a default status name mapped to the stable `draft` status type.
- Status names should be configurable per project later, but status type semantics should remain stable.
- Only one project status should have the exclusive `execute` type and one should have the exclusive `review` type.
- Only one active default status should exist per project.
- CLI update phases can include `draft`, `execute`, `review`, `deliver`, `complete`, `blocked`, and `cancelled` for protocol compatibility.
- Soft deletion is represented by `deleted_at` in the schema, not by adding `deleted` or `removed` lifecycle statuses.

## Lifecycle Requirements

### Normal Agent Flow

1. Human or CLI creates a ticket with at least one objective.
2. Objective is submitted or queued.
3. Agent attaches.
4. Objective moves to `executing`.
5. Agent posts progress updates or heartbeats.
6. Agent asks a blocking question if needed and stops.
7. Agent delivers summary, artifacts, and change rationales.
8. Objective moves to `complete`; ticket moves to `review`.
9. If another draft objective exists and auto-advance is enabled, OpenOverlord queues it for runner execution.

### Follow-Up Flow

Requirements:

- Delivered tickets remain in review during discussion.
- Ordinary discussion, clarification, decisions, and summaries do not reopen execution.
- Explicit file/code work after delivery requires a `begin-follow-up-work` signal.
- Work signals after delivery move the objective to `pending_delivery`.
- A follow-up delivery moves it back to `complete`.

### Blocking Flow

Requirements:

- `ask` records a precise blocking question.
- The ticket should move to a review/blocked-visible state.
- The agent should stop after asking.
- A later human answer should be recorded as `user_follow_up` or `decision`.

## Acceptance Criteria

- A ticket with multiple objectives can be created and inspected entirely from the CLI.
- Attaching to a ticket returns the correct active objective rather than only the ticket title.
- Objective state changes are auditable in event history.
- Ticket status changes do not destroy objective ordering or session history.
- Follow-up discussion does not force redelivery unless new execution work is recorded.
- Shared context written by one objective is visible to later objectives on the same ticket.
