# CLI Module

The `ovld` command-line surface — Overlord's primary, CLI-first product.
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
- [Test Plan](docs/testing.md): test plan for the `cli`, `protocol`, and `runner` components — management commands, protocol lifecycle/attach-shape/validation conformance, runner queue atomicity, and surface smoke tests. Part of the root [TEST_PLAN.md](../TEST_PLAN.md).

## Code & Tests

The packaged CLI lives in this module as a self-contained Yarn sub-project:

```bash
yarn build:cli            # compile TypeScript to cli/dist/
yarn test:cli             # unit + subprocess smoke tests
yarn pack:cli             # produce an installable tarball
node cli/bin/ovld.mjs version
```

Layout:

```
cli/
  bin/ovld.mjs            # published bin entry (imports compiled dist/)
  src/                    # TypeScript implementation
  dist/                   # build output (gitignored)
  test/                   # colocated tests, including cli/test/e2e/
  package.json            # bin map, build scripts, pack metadata
```

Phase 0–3 ship the core service layer, management commands, and agent
protocol through docs 01–03. Runner commands (doc 04) are not yet implemented.
Run `yarn build` before using the compiled CLI (`node cli/bin/ovld.mjs …`).

## Interaction Boundaries

Per the contract, the CLI/protocol/runner surfaces reach persistence only
through the **service layer** in ACID transactions — never direct table writes.
See the Interaction Surfaces section of [`CONTRACT.md`](../CONTRACT.md) before
making any cross-module change.
