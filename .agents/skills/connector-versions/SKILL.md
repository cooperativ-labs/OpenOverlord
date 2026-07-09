---
Name: connector-versions
Description: Keep agent connector plugin and MCP version numbers in sync whenever files under connectors/ change. Run the sync script after connector edits and bump the patch version for user-visible connector releases.
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
user-invocable: true
---

# Connector Versions

## When to use this skill

Use this skill whenever you add, remove, or materially change files under `connectors/`, including:

- Adapter plugin manifests, hooks, slash commands, skills, or MCP shims
- Connector core workflow instructions in `connectors/core/`
- Connector docs that ship with an adapter bundle

Do **not** skip this step when only one adapter changes. All agent connectors share one semver in `connectors/VERSION`.

## Source of truth

`connectors/VERSION` is the canonical connector release version. The sync script propagates it to:

- `connectors/adapters/Codex/.Codex-plugin/plugin.json`
- `connectors/adapters/codex/.codex-plugin/plugin.json`
- `connectors/adapters/cursor/.cursor-plugin/plugin.json`
- `connectors/adapters/codex/scripts/overlord-mcp.mjs` (`serverInfo.version`)
- `connectors/adapters/cursor/scripts/overlord-mcp.mjs` (`serverInfo.version`)

Never hand-edit those version fields in multiple files. Update `connectors/VERSION` through the script, then sync.

## Required workflow

1. Finish the connector code/doc changes first.
2. Run the version sync script:
   - For normal connector changes that users should reinstall: `yarn connectors:version:bump`
   - To propagate an already-chosen version without bumping: `yarn connectors:version:sync`
3. Verify sync status: `yarn connectors:version:check`
4. Include the version bump in the same change set as the connector edits.
5. Mention the new connector version in your delivery summary so users know to re-run `ovld agent-setup <agent>`.

## Commands

```bash
yarn connectors:version:bump    # bump patch in connectors/VERSION and sync all targets
yarn connectors:version:sync    # sync all targets to connectors/VERSION
yarn connectors:version:check   # fail if any target drifts from connectors/VERSION
```

Equivalent direct invocation:

```bash
node scripts/sync-connector-versions.mjs --bump patch
node scripts/sync-connector-versions.mjs --sync
node scripts/sync-connector-versions.mjs --check
```

Use `--bump minor` or `--bump major` only when the connector release warrants it. Default to patch bumps for routine connector updates.

## Rules

- Run the script in the same PR/change as the connector edits, before delivering.
- Do not leave adapter versions diverged (for example Codex at `0.2.3` while Cursor still says `0.2.0`).
- If you add a new adapter with its own `plugin.json` or MCP `serverInfo.version`, extend `scripts/sync-connector-versions.mjs` in the same change.
- `contractVersion` in conformance manifests is separate from plugin semver; do not confuse the two.

<!-- version: 1.0.0 -->
