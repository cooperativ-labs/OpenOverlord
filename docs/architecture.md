# Overlord Architecture — Reading Order

This page is the **ordered index** over Overlord's architecture series: the
`NN-*.md` behavior specs that, read in sequence, explain how the whole system
works. The files stay **colocated with the module that owns them** (under each
`<module>/docs/`), so the global series is physically spread across several
modules. This index is what ties them back into a single narrative.

> **How the numbers work.** Each file keeps a stable `NN-` number used as its
> global series ID and as a reference-spec path in [`CONTRACT.md`](../CONTRACT.md).
> Those numbers are *not* contiguous and are *not* the reading order — they are
> stable identifiers. **Read the series in the order below**, not by number.
> (The well-ordered [`webapp/docs/ui/`](../webapp/docs/ui/README.md) set, `00…10`,
> is the discipline this index brings to the cross-module series.)

## Read in this order

| Order | File | Module | What it covers |
| --- | --- | --- | --- |
| 1 | [Core Domain & Lifecycle](../cli/docs/06-core-domain-and-lifecycle.md) | cli | Projects, missions, objectives, sessions, events, statuses, and state transitions — the domain everything else builds on. |
| 2 | [CLI-First Product Surface](../cli/docs/02-cli-first-product-surface.md) | cli | Management commands, configuration, project linking, and output contracts. |
| 3 | [Agent Protocol](../cli/docs/03-agent-protocol.md) | cli | The `ovld protocol` lifecycle: context assembly, updates, delivery, attachments. |
| 4 | [Runner & Launch Execution](../cli/docs/04-runner-and-launch-execution.md) | cli | Execution requests, the local runner, launch-command generation, and auto-advance. |
| 5 | [Review, Artifacts & Change Tracking](../cli/docs/11-review-artifacts-and-change-tracking.md) | cli | Delivery review records, artifacts, rationale coverage, and local diff support. |
| 6 | [Connectors & Agent Plugins](../connectors/docs/05-connectors-and-agent-plugins.md) | connectors | The connector core, plugins, adapters, and prompt wrappers that bind agents to Overlord. |
| 7 | [Automations Overview](../automations/docs/01-automations-overview.md) | automations | Optional AI automations (objective titling, summarization) and how they plug in. |
| 8 | [USER_TOKEN Authentication](../auth/docs/07-user-token-authentication.md) | auth | Mix-and-match authentication and the `USER_TOKEN` lifecycle. |
| 9 | [Role-Based Access Control](../auth/docs/08-role-based-access-control.md) | auth | Roles, permissions, and authorization. |
| 10 | [Database Schema Contract](../database/docs/09-database-schema-contract.md) | database | The portable SQLite/Postgres schema contract and extension points. Companion: [Schema Contract Review](../database/docs/09-database-schema-contract-review.md). |
| 11 | [Database Table Groups](../database/docs/10-database-table-groups.md) | database | Core vs. à-la-carte table groups and capability gating. |
| 12 | [Private-Network PostgreSQL Deployment](../database/docs/12-private-network-postgresql-deployment-plan.md) | database | Deployment plan for a private-network Postgres backend. |
| 13 | [Database Seeding Framework](../database/docs/13-database-seeding-framework.md) | database | How seed data is defined and applied across adapters. |

## A note on numbering

The cross-module series uses stable `NN-` identifiers pinned by
[`CONTRACT.md`](../CONTRACT.md). Read the table above in order, not by number.
The [`webapp/docs/ui/`](../webapp/docs/ui/README.md) set (`00…10`) follows the
same discipline for UI specs.
