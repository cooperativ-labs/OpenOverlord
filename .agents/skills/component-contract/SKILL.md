---
name: component-contract
description: Enforce the Overlord component interaction contract. Invoke before any cross-module implementation or change that touches a component interface.
---

# Component Contract

**You MUST invoke this skill — and read `CONTRACT.md` — before implementing any change that crosses module boundaries or modifies Overlord's component interfaces.**

This is not optional. The contract is the single source of truth for how components interact. Code follows from the contract, never the other way around.

---

## When This Skill Applies

Invoke this skill whenever you are about to:

- Implement a new `ovld protocol` command or change an existing one
- Add or modify a database table, column, index, or constraint
- Add a new connector (agent harness adapter)
- Modify connector capabilities or hook types
- Create or modify a REST API endpoint
- Implement an extension that uses Overlord extension points
- Add a new value to any controlled vocabulary
- Add a new interaction surface between two components
- Create a conformance manifest for a shipped component

If you are unsure whether your change crosses a module boundary, read `CONTRACT.md` — the component registry section will tell you.

---

## Required Reading

Before writing code that crosses a module boundary, you MUST read:

1. **`CONTRACT.md`** — the master component interaction contract (project root)
2. The component registry section for the component(s) your change touches
3. The interaction surface your change uses or creates

If you have not read `CONTRACT.md` in this session, read it now before proceeding.

---

## The Contract-First Rule

**Any change that extends or conflicts with the existing contract MUST update `CONTRACT.md` and the relevant `contract/*.yaml` files BEFORE implementing the change in other code.**

This means: if your implementation would do any of the following, stop and update the contract first:

- Add a new interaction surface between components
- Change the signature of a protocol command (add, remove, or rename required flags)
- Add or remove a component from the component registry
- Restrict or open an extension point
- Add a new hook type or connector capability flag
- Add a value to a closed vocabulary

Do not write implementation code that would invalidate the contract. The contract describes what is true; the code implements what the contract says.

---

## Pre-Implementation Checklist

Answer these questions before writing code:

**1. Which component does this change belong to?**
- Check `contract/components.yaml` for the component registry
- If the change belongs to a component not yet listed, add it to the contract first

**2. Which interaction surface does this change use or create?**
- Is the surface already defined in `CONTRACT.md` "Interaction Surfaces"?
- If the change creates a NEW surface between components, add it to `CONTRACT.md` and `contract/components.yaml` first

**3. Does this change modify a stable interface?**
These are breaking changes that require a contract version bump:
- Protocol command names or required flags
- Database column names, types, or NOT NULL constraints
- Closed vocabulary values
- Response shape versioned fields

If yes → update `CONTRACT.md`, increment `contractVersion` in `contract/components.yaml`, add a changelog entry, then implement.

**4. Does this use an extension point?**
- Is the extension point listed in `contract/extension-points.yaml`?
- If using `database-extension`: are table names prefixed `ext_<name>_`? Is migration component `ext:<name>`?
- If using `custom-connector`: are all capability flags from `approvedConnectorCapabilities`? Are hook types from `approvedHookTypes`?
- If using `open-vocabulary-value`: are values namespaced?

**5. Does the shipped component need a conformance manifest?**
Any connector, extension, database adapter, auth provider, or REST module that ships must have a `conformance-manifest.yaml` in its root, validated against `contract/conformance-manifest.schema.yaml`.

---

## When to Update the Contract

| Your Change | What to Update |
| --- | --- |
| New component | `contract/components.yaml` + `CONTRACT.md` component registry |
| New interaction surface | `contract/components.yaml` + `CONTRACT.md` interaction surfaces |
| New protocol command | `contract/protocol-commands.yaml`; update `CONTRACT.md` if stable interface changes |
| Changed command flag (breaking) | `contract/protocol-commands.yaml` + `CONTRACT.md` + version bump |
| New database table/column | `planning/feature-plans/09-database-schema-contract.md` |
| New extension point | `contract/extension-points.yaml` + `CONTRACT.md` |
| New connector capability flag | `contract/extension-points.yaml` `approvedConnectorCapabilities` list |
| New hook type | `contract/extension-points.yaml` `approvedHookTypes` list |
| Closed vocabulary change | `contract/extension-points.yaml` + schema contract + version bump |
| Open vocabulary new core value | `planning/feature-plans/09-database-schema-contract.md` Controlled Vocabularies |
| New connector shipped | Conformance manifest only (no contract update unless new capabilities needed) |
| New extension shipped | Conformance manifest only (no contract update unless new extension points needed) |

---

## Order of Operations

1. Read `CONTRACT.md`
2. Identify which component and surface your change belongs to
3. **If the change requires a contract update: update `CONTRACT.md` and `contract/*.yaml` files first**
4. Write the implementation code
5. If shipping a connector or extension: create or update its `conformance-manifest.yaml`
6. Verify the manifest validates against `contract/conformance-manifest.schema.yaml`

Do not skip step 3.

---

## Delivery Reminder

When delivering a ticket that involved contract-touching changes, include `CONTRACT.md` and any updated `contract/*.yaml` files in `changeRationales` — these are first-class behavioral file changes, not documentation noise.

<!-- version: 1.0.0 -->
