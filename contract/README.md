# Contract Directory

This directory contains the machine-readable counterparts to `CONTRACT.md`.

**The authoritative narrative contract lives in [`CONTRACT.md`](../CONTRACT.md) at the project root. Read that first.**

## Table of Contents

- [For Users](#for-users)
  - [Understanding the contract](#understanding-the-contract)
- [For Developers](#for-developers)
  - [Files](#files)
  - [How to Use](#how-to-use)
  - [For shipped components](#for-shipped-components-connectors-extensions-adapters)
  - [For agents](#for-agents)

## For Users

### Understanding the contract

The contract defines how Overlord's modules interact — what each component owns,
which surfaces are stable, and how extensions plug in. If you are configuring or
extending Overlord (custom connectors, auth providers, schema extensions), start
with the narrative spec in [`CONTRACT.md`](../CONTRACT.md). The YAML files in
this directory are the machine-readable version of that spec, used by tooling and
agents.

## For Developers

### Files

| File | Purpose |
| --- | --- |
| `components.yaml` | Component registry — capabilities, ownership, interaction surface declarations |
| `protocol-commands.yaml` | Protocol command names, required flags, and response shape versions |
| `extension-points.yaml` | Sanctioned extension points, approved capability flags, open/closed vocabularies |
| `conformance-manifest.schema.yaml` | JSON Schema (YAML format) for component conformance manifests |

### How to Use

#### For implementors

Before writing code that crosses a module boundary, read `CONTRACT.md` and the relevant YAML file for the surface you are using.

If your change extends or modifies the contract:
1. Update `CONTRACT.md` and the relevant YAML file(s)
2. Increment `contractVersion` in `components.yaml`
3. Add a changelog entry to `CONTRACT.md`
4. Then implement the code change

### For shipped components (connectors, extensions, adapters)

Every component that ships against Overlord must provide a `conformance-manifest.yaml` in its root. The manifest must validate against `conformance-manifest.schema.yaml`.

Run `ovld contract check <manifest-file>` to validate (or use the equivalent validation script until `ovld contract` is implemented).

### For agents

See `.claude/skills/component-contract.md` for the enforced agent workflow. Invoke it before any cross-module change.
