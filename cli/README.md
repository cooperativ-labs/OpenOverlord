# CLI Module

The `ovld` command-line surface — OpenOverlord's primary, CLI-first product.
This module is the home for everything a user or agent invokes as `ovld …`.

## Contract Components

This module is the developer-facing home for three components defined in
[`CONTRACT.md`](../CONTRACT.md):

| Component | Stable id | What it owns |
| --- | --- | --- |
| CLI Layer | `cli` | Management command names/shapes, project linking & discovery, config file locations (`overlord.toml`, `.overlord/project.json`), human-readable output conventions |
| Protocol Layer | `protocol` | `ovld protocol` subcommands and flags, session lifecycle (`attach → (update\|heartbeat)* → (ask\|deliver)`), context-assembly format, delivery payload + change-rationale recording |
| Runner Layer | `runner` | `execution_requests` queue claiming and launch, working-directory resolution, `ovld runner` commands, execution-target selection |

These stay distinct components in the contract (separate interaction surfaces
and ownership). They are grouped into one developer module because they are all
the `ovld` command surface and tend to be worked on together.

## Documentation

Requirements and behavior specs are colocated in this module's
[`docs/`](docs/) folder (see the root [README](../README.md#modules) for the
colocation convention):

- [01 — Core Domain and Lifecycle](docs/01-core-domain-and-lifecycle.md): projects, tickets, objectives, sessions, events, statuses, state transitions.
- [02 — CLI-First Product Surface](docs/02-cli-first-product-surface.md): management commands, configuration, project linking, output contracts.
- [03 — Agent Protocol](docs/03-agent-protocol.md): `ovld protocol` lifecycle, context assembly, updates, delivery, attachments.
- [04 — Runner and Launch Execution](docs/04-runner-and-launch-execution.md): execution requests, local runner, launch command generation, auto-advance.
- [06 — Review, Artifacts, and Change Tracking](docs/06-review-artifacts-and-change-tracking.md): delivery review records, artifacts, rationale coverage, local diff support.

## Code & Tests

No implementation has landed in this module yet. When it does, colocate source
and tests here (e.g. `cli/<area>/foo.ts` + `cli/<area>/foo.test.ts`), following
the pattern established in [`auth/`](../auth/README.md) / `src/rbac`.

## Interaction Boundaries

Per the contract, the CLI/protocol/runner surfaces reach persistence only
through the **service layer** in ACID transactions — never direct table writes.
See the Interaction Surfaces section of [`CONTRACT.md`](../CONTRACT.md) before
making any cross-module change.
