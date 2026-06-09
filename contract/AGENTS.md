# Contract Directory — Agent Extension Guide

This file tells agents how to update the contract when extending any OpenOverlord module. The `contract/` directory holds the machine-readable counterparts to [`CONTRACT.md`](../CONTRACT.md). Read `CONTRACT.md` first — it is the authoritative narrative contract.

---

## What "extending the contract" means

You update the contract when a module change:
- Adds a new component or component capability
- Adds or changes an interaction surface between components
- Adds or changes a protocol command or required flag
- Changes a stable interface (requires a version bump)
- Adds a new sanctioned extension point
- Adds a new connector capability flag or hook type
- Adds a value to a closed vocabulary

You do **not** update the contract for:
- Adding a new connector (conformance manifest only)
- Adding a new extension (conformance manifest only)
- Adding an open vocabulary value that stays extension-specific
- Internal refactors that don't cross module boundaries

---

## The Contract-First Rule

**The contract must be updated before any implementation code that extends or conflicts with it.** If you are writing code that would invalidate the current contract, stop and update the contract first.

---

## Files in This Directory

| File | What it describes | When to update |
| --- | --- | --- |
| `components.yaml` | Component registry: capabilities, ownership, interaction surfaces, contract version | New component, new surface, new capability, any version bump |
| `protocol-commands.yaml` | `ovld protocol` subcommand names, required/optional flags, response shape versions | New protocol command, changed command flag |
| `extension-points.yaml` | Sanctioned extension points, approved connector capability flags, approved hook types, open/closed vocabularies | New extension point, new capability flag, new hook type, closed vocabulary change |
| `conformance-manifest.schema.yaml` | JSON Schema (YAML) that every shipped component's conformance manifest must validate against | New required manifest field |

---

## Procedure: Adding a New Component

1. Add an entry to `components.yaml` under `components:` with:
   - `stableId`: lowercase identifier
   - `label`: human-readable name
   - `owns`: list of capabilities
   - `doesNotOwn`: list of delegated concerns
   - `interactionSurfaces`: list of surfaces this component participates in
2. Add the component to the Component Registry section of `CONTRACT.md`.
3. If the component introduces a new interaction surface, add that surface to both `CONTRACT.md` and `components.yaml`.
4. Increment `contractVersion` in `components.yaml`.
5. Add a changelog entry to `CONTRACT.md`.

---

## Procedure: Adding or Changing a Protocol Command

1. Add/update the command in `protocol-commands.yaml`:
   ```yaml
   - name: <subcommand>
     requiredFlags: [--session-key, --ticket-id, ...]
     optionalFlags: [--summary, ...]
     responseShapeVersion: "1"
   ```
2. If the change modifies a required flag or response shape on an existing command, it is **breaking** — increment `contractVersion` in `components.yaml` and add a changelog entry.
3. Update `CONTRACT.md` Protocol Layer section.

---

## Procedure: Adding a New Extension Point

1. Add the extension point to `extension-points.yaml` under `extensionPoints:`.
2. Add it to the Extension Points table in `CONTRACT.md`.
3. If it requires a new connector capability flag or hook type, add it to `approvedConnectorCapabilities` or `approvedHookTypes` in `extension-points.yaml`.

---

## Procedure: Contract Version Bump

A version bump is required for any **breaking** stable-interface change:
- Protocol command name renamed or required flag removed/renamed
- Database column renamed, type changed, or NOT NULL added without default
- Closed vocabulary value removed
- Response shape field removed or renamed

**Steps:**

1. Increment `contractVersion` in `components.yaml` (e.g. `0.2-draft` → `0.3-draft` or `1.0` for stable release).
2. Add a changelog entry to `CONTRACT.md` under "Contract Version" table:
   ```markdown
   | `0.3-draft` | Brief description of the breaking change. |
   ```
3. Update all conformance manifests that declare the old version.

---

## Validating a Conformance Manifest

Every shipped connector, extension, database adapter, auth provider, or REST module must have a `conformance-manifest.yaml`. Validate it with:

```sh
ovld contract check <path-to-conformance-manifest.yaml>
```

The manifest schema is in `contract/conformance-manifest.schema.yaml`. Required fields:
- `contractVersion`: the version validated against
- `componentType`: one of `connector`, `extension`, `database-adapter`, `auth-provider`, `rest-module`
- `componentKey`: stable lowercase identifier
- Declared capabilities, extension points, and vocabulary extensions used

---

## Example: Minimal Conformance Manifest

```yaml
contractVersion: "0.2-draft"
componentType: connector
componentKey: my-agent
capabilities:
  - supports-prompt-wrapper
hookTypes:
  - UserPromptSubmit
openVocabularyValues: []
```

---

## Cross-Module Checklist

- [ ] Read `CONTRACT.md` before touching any contract file
- [ ] New component → update `components.yaml` + `CONTRACT.md` component registry
- [ ] New surface → update `components.yaml` + `CONTRACT.md` interaction surfaces
- [ ] New protocol command → update `protocol-commands.yaml`
- [ ] Breaking change → bump `contractVersion` in `components.yaml` + add changelog
- [ ] New extension point → update `extension-points.yaml` + `CONTRACT.md`
- [ ] New capability flag or hook type → update `extension-points.yaml`
- [ ] Implementation code does not land before the contract update
