# CLI Module — Agent Extension Guide

This file tells agents how to extend the CLI module to add new capabilities for users. The CLI module covers three contract components: **CLI Layer** (`cli`), **Protocol Layer** (`protocol`), and **Runner Layer** (`runner`). Read [`CONTRACT.md`](../CONTRACT.md) and the [component-contract skill](../.claude/skills/component-contract/SKILL.md) before making any cross-module change.

---

## What "extending the CLI" means

Extensions in this module fall into three areas:

| Extension type | Example user request |
| --- | --- |
| New management command | "Add `ovld project archive`" |
| New protocol subcommand | "Add `ovld protocol reopen`" |
| Runner change | "Support a new execution target type" |

Each type has a different procedure below.

---

## Before You Start

1. Read `CONTRACT.md` — CLI, Protocol, and Runner Layer sections.
2. Read the relevant spec doc in `cli/docs/`:
   - Management commands → [`02-cli-first-product-surface.md`](docs/02-cli-first-product-surface.md)
   - Protocol commands → [`03-agent-protocol.md`](docs/03-agent-protocol.md)
   - Runner → [`04-runner-and-launch-execution.md`](docs/04-runner-and-launch-execution.md)
3. Check if the change modifies a **stable interface** (command name or required flag). If yes, update the contract first — see [contract/AGENTS.md](../contract/AGENTS.md).

---

## Adding a New Management Command

Management commands are top-level `ovld <noun> <verb>` operations (e.g. `ovld project link`, `ovld mission create`).

**Steps:**

1. **Check `CONTRACT.md`** to confirm the command belongs to the CLI Layer (stable id: `cli`), not the Protocol or Runner Layer.
2. **Add the command definition** in `cli/<area>/` (create the subdirectory if needed). Follow the existing colocated pattern: `cli/<area>/cmd.ts` + `cli/<area>/cmd.test.ts`.
3. **Reach persistence only through the service layer** in ACID transactions — never write to database tables directly from CLI handlers.
4. **Apply auth**: call `can(actor, action, resource)` via the Auth Layer before mutating any resource. Do not skip the permission check even for local/dev flows.
5. **Output conventions**: follow the human-readable output format documented in [`02-cli-first-product-surface.md`](docs/02-cli-first-product-surface.md). Commands should support `--json` for machine-readable output.
6. **Update the contract** in `contract/protocol-commands.yaml` only if the new command is surfaced as a protocol operation. Pure management commands live in `CONTRACT.md` CLI Layer section — add a line there if the command represents a new stable interface.
7. **Write tests** colocated with the implementation (`cli/<area>/cmd.test.ts`).

---

## Adding a New Protocol Subcommand

Protocol commands (`ovld protocol <subcommand>`) are the agent↔Overlord surface. They are stable interfaces — any addition or flag change requires a contract update.

**Steps:**

1. **Update `contract/protocol-commands.yaml`** first — add the new subcommand with its required/optional flags and expected response shape version.
2. **Update `CONTRACT.md`** Protocol Layer section if the command changes the session lifecycle or delivery contract.
3. **Increment the contract version** in `contract/components.yaml` if the change is a breaking stable-interface change (renamed command, removed required flag, changed response schema).
4. **Implement the subcommand** in `cli/protocol/<subcommand>.ts`. Required session lifecycle sequence: `attach → (update|heartbeat)* → (ask|deliver)`.
5. **Shell-special content**: any command that accepts user-supplied text (summaries, questions) must support `--summary-file -` / `--question-file -` stdin piping per the contract's shell-escaping rules. See [`reference/shell-escaping.md`](../connectors/docs/) if available.
6. **Return JSON on stdout** on success; non-zero exit on error.
7. **Write integration tests** that exercise the full request/response cycle.

---

## Extending the Runner

The Runner Layer (stable id: `runner`) owns `execution_requests` queue claiming and agent launch.

**Steps for supporting a new execution target type:**

1. **Add the new type to `execution_targets.type`** open vocabulary in `database/docs/09-database-schema-contract.md` — open vocabulary, no contract version bump needed.
2. **Implement launch logic** in `cli/runner/<target-type>/`. The runner must claim `execution_requests` atomically via compare-and-set and append `mission_events` + `entity_changes` in the same transaction.
3. **Add the target type to `contract/components.yaml`** under the Runner Layer capabilities.
4. **Write tests** covering: claim, launch, failure handling, and conflict (double-claim) scenarios.
5. **Document the new target type** in [`04-runner-and-launch-execution.md`](docs/04-runner-and-launch-execution.md).

---

## File Placement Convention

```
cli/
  docs/           ← spec docs for this module
  AGENTS.md       ← this file
  README.md       ← architectural overview
  <area>/         ← management commands, organized by domain area
    cmd.ts
    cmd.test.ts
  protocol/       ← ovld protocol subcommand implementations
  runner/         ← runner and launch execution
```

No implementation has landed yet. When it does, follow the colocated pattern established by `auth/src/rbac/`.

---

## Cross-Module Checklist

- [ ] Read `CONTRACT.md` CLI / Protocol / Runner Layer section
- [ ] Protocol command change → update `contract/protocol-commands.yaml` first
- [ ] Breaking interface change → bump contract version in `contract/components.yaml`
- [ ] Database access → service layer only, never direct table writes
- [ ] Auth-gated operation → call `can(actor, action, resource)` via Auth Layer
- [ ] New runner target type → update open vocabulary in database schema contract
