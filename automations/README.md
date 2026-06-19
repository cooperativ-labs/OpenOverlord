# Automations Module

Optional AI automations for Open Overlord. Developers register simple automations behind
a shared `Automation` interface; the reference implementation is Gemini-backed text
summarization and objective title generation.

## Table of Contents

- [For Users](#for-users)
  - [Configuration](#configuration)
- [For Developers](#for-developers)
  - [Contract Component](#contract-component)
  - [Documentation](#documentation)
  - [Code & Tests](#code--tests)
  - [Interaction Boundaries](#interaction-boundaries)

## For Users

### Configuration

Copy [`.env.local.example`](../.env.local.example) to `.env.local` for development, or
copy [`.env.prod.example`](../.env.prod.example) to `.env.prod` for packaged builds, and set `GEMINI_API_KEY` to enable
Gemini-backed automations. When the key is missing or a call fails, automations return `null` and
callers should use deterministic local fallbacks (see `deriveTitleFromInstructionText`).

When enabled, ticket and objective titles are refined asynchronously with Gemini
after an immediate local title is set. Title updates stream through the
`entity_changes` feed so the web board refreshes live.

## For Developers

### Contract Component

Maps to the **Automations Layer** (`automations`) in [`CONTRACT.md`](../CONTRACT.md), which owns:

- The `Automation` interface and built-in automation registry
- Gemini provider configuration (`GEMINI_API_KEY`, optional `GEMINI_MODEL`)
- Reference summarization automations
- Fire-and-forget helpers that persist results through caller-supplied store interfaces

It does **not** own database schema, ticket/objective lifecycle, or agent protocol
behavior.

### Documentation

- [01 — Automations Overview](docs/01-automations-overview.md): automation model, Gemini setup, and extension guide
- [02 — Branch Strategy Automation](docs/02-branch-strategy-automation.md): proposed plan for base-branch selection and branch-per-ticket/objective launch automation
- [03 — Worktree Storage Layout](docs/03-worktree-storage-layout.md): where git worktrees should live (central `~/.ovld/worktrees`, outside the synced repo) and how worktrees fold into the branch-strategy plan
- [Test Plan](docs/testing.md): unit coverage for title derivation, fallbacks, and registry behavior

### Code & Tests

Implementation lives under [`src/`](src):

- `types.ts` — shared `Automation` interface
- `registry.ts` — built-in automation catalog and registration hook for new automations
- `title-summarizer/` — self-contained reference automation (provider config, tools, helpers, persistence helpers)

Inside `title-summarizer/`:

- `config.ts` / `gemini-client.ts` — Gemini provider configuration and client lifecycle
- `tools/summarize-text.ts` — generic Gemini summarization
- `tools/summarize-objective-title.ts` — ticket-style objective title summarization
- `objectives/generate-objective-title.ts` — `generateObjectiveTitle` and `generateAndSetObjectiveTitle`
- `helpers/title.ts` — deterministic local title derivation

Colocated tests:

- `src/title-summarizer/helpers/title.test.ts`
- `src/title-summarizer/objectives/generate-objective-title.test.ts`
- `src/registry.test.ts`

### Interaction Boundaries

Other components consume automations only through the `@overlord/automations` package API.
Persistence must go through injected callbacks such as `ObjectiveTitleStore`; the
module must not read or write domain tables directly.
