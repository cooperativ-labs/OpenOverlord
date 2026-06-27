# Connectors Module — Agent Extension Guide

This file tells agents how to extend the Connectors module to add new agent harness connectors for users. Read [`CONTRACT.md`](../CONTRACT.md) and the [component-contract skill](../.claude/skills/component-contract/SKILL.md) before making any cross-module change.

---

## What "extending connectors" means

A connector lets an AI coding harness (Claude Code, Codex, Cursor, etc.) speak the `ovld protocol` and inherit mission context. Extensions in this module fall into four categories:

| Extension type | Example user request |
| --- | --- |
| New agent connector | "Add a connector for OpenCode / Windsurf / Zed" |
| New hook type | "Add a Stop hook for pending-delivery checks" |
| Extend connector core | "Add a new canonical instruction to all connectors" |
| New capability flag | "Connectors can now declare `supports-multi-session`" |

Each type has a different procedure below.

---

## Before You Start

1. Read `CONTRACT.md` — Connector Layer section (stable id: `connector`).
2. Read [`connectors/docs/05-connectors-and-agent-plugins.md`](docs/05-connectors-and-agent-plugins.md) for the four-layer model: connector core, plugins, adapters, and prompt wrappers.
3. Read [`connectors/docs/agent-harness-configuration-architecture.md`](docs/agent-harness-configuration-architecture.md) for ownership boundaries.
4. Check `contract/extension-points.yaml` for approved capability flags and hook types before adding new ones.
5. After connector edits, follow the [connector-versions skill](../.claude/skills/connector-versions/SKILL.md) and run `yarn connectors:version:bump`.

---

## Adding a New Agent Connector

A new connector is the primary sanctioned extension point for this module. It requires a conformance manifest but does not require a contract version bump unless it introduces new capability flags or hook types.

**Steps:**

1. **Create the connector directory**: `connectors/adapters/<agent-name>/`.

2. **Write the connector plugin** — a Markdown (or native plugin format) file that extends the connector core. Adapter `skills/overlord-mission/SKILL.md` templates must include `<!-- @connector-core -->`; `ovld agent-setup` interpolates `connectors/core/overlord-mission/SKILL.md` at that marker. Required canonical instructions (from the core):
   - Attach first (`ovld protocol attach`)
   - Treat the mission prompt as authoritative
   - Post meaningful progress updates
   - Use heartbeat during long work with no meaningful update
   - Ask exactly one blocking question and stop when blocked
   - Deliver last with summary, artifacts, and change rationales
   - Record all meaningful file changes as structured rationales
   - Use stdin/file flags for shell-special content
   - Do not continue after delivery unless explicitly asked
   - Run local repair before asking the user to fix setup

3. **Write the plugin adapter** — packaging/install glue for the agent's native plugin system. Adapters must:
   - Be idempotent (re-running setup produces the same result)
   - Not clobber existing user settings
   - Be detectable by `ovld doctor` as stale, missing, or partially installed

4. **List managed files** in the adapter's manifest so `ovld doctor` can verify them.

5. **Write a prompt wrapper** if the agent needs mission context prepended at launch time. The wrapper receives a context file path and emits the final prompt text.

6. **Create `connectors/adapters/<agent-name>/conformance-manifest.yaml`** declaring:
   ```yaml
   contractVersion: "0.2-draft"
   componentType: connector
   componentKey: <agent-name>
   capabilities:
     - <only approved flags from contract/extension-points.yaml>
   hookTypes:
     - <only approved types from contract/extension-points.yaml>
   ```

7. **Validate**: run `ovld contract check connectors/adapters/<agent-name>/conformance-manifest.yaml`.

8. **Document** the connector's launch flags, managed files, and hook scripts in `connectors/adapters/<agent-name>/README.md`.

---

## Adding a New Hook Type

Hook types (`UserPromptSubmit`, `PermissionRequest`, `Stop`) are **stable interfaces** listed in `contract/extension-points.yaml`. Adding a new type requires a contract update first.

**Steps:**

1. **Update `contract/extension-points.yaml`**: add the new hook name to `approvedHookTypes`.
2. **Update `CONTRACT.md`** Connector Layer section with the new hook's event contract.
3. **Increment the contract version** in `contract/components.yaml` and add a changelog entry to `CONTRACT.md`.
4. **Implement the hook script** in `connectors/adapters/<agent-name>/hooks/` (or the connector-specific hook location).
5. **Hook scripts must not write to the database directly** — use `ovld protocol hook-event` or `ovld protocol update` only.
6. **Update affected conformance manifests** to declare the new hook type.

---

## Extending the Connector Core

The connector core is the set of canonical Markdown workflow instructions every plugin extends. Changes to the core affect all connectors.

**Steps:**

1. **Check `connectors/docs/05-connectors-and-agent-plugins.md`** to confirm the instruction belongs in the core (universal to all agents) rather than a per-agent plugin.
2. **Draft the new canonical instruction** following the imperative, agent-readable style of the existing core instructions.
3. **Update all existing connector plugins** that extend the core if the new instruction changes agent behavior at session start/end.
4. **Document the change** in `connectors/docs/05-connectors-and-agent-plugins.md` under "Canonical Connector Core."

---

## Adding a New Capability Flag

Capability flags (e.g. `supports-checkpointing`, `supports-multi-session`) are listed in `contract/extension-points.yaml` under `approvedConnectorCapabilities`. New flags require a contract update.

**Steps:**

1. **Add the flag** to `approvedConnectorCapabilities` in `contract/extension-points.yaml`.
2. **Add a description** of what the flag means in `CONTRACT.md` Connector Layer section.
3. **Increment contract version** if the flag represents a breaking stable-interface change.
4. **Declare the flag** in the conformance manifests of connectors that support it.

---

## File Placement Convention

```
connectors/
  adapters/
    claude/              ← Claude Code adapter (reference implementation)
      conformance-manifest.yaml
      README.md
      hooks/
        user-prompt-submit.sh
        permission-request.sh
    codex/               ← Codex adapter
    cursor/              ← Cursor adapter
    <new-agent>/         ← New connector goes here
  docs/                  ← Module-level specs
  AGENTS.md              ← this file
  README.md              ← architectural overview
```

No adapter implementations have landed yet. When they do, the Claude and Codex adapters serve as the reference implementations.

---

## Cross-Module Checklist

- [ ] Read `CONTRACT.md` Connector Layer section
- [ ] New hook type or capability flag → update `contract/extension-points.yaml` first
- [ ] Hook scripts → use `ovld protocol` commands only, no direct DB writes
- [ ] Conformance manifest created and validated for every new connector
- [ ] `ovld agent-setup <agent>` and `ovld doctor` behavior documented
