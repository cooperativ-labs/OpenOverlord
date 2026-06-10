# Automations Module — Agent Extension Guide

Read [`CONTRACT.md`](../CONTRACT.md) and the [component-contract skill](../.claude/skills/component-contract/SKILL.md) before adding automations that other modules will call.

---

## What "extending automations" means

| Extension type | Example user request |
| --- | --- |
| New built-in automation | "Add an automation that classifies ticket priority" |
| New provider | "Support OpenAI for summarization" |
| New automation helper | "Generate acceptance criteria from an objective" |

---

## Before You Start

1. Read `CONTRACT.md` — Automations Layer section (`automations`).
2. Read [`automations/docs/01-automations-overview.md`](docs/01-automations-overview.md).
3. Confirm your automation does not read or write domain tables directly.

---

## Adding a New Built-In Automation

**Steps:**

1. Create a self-contained folder under `src/automations/<automation-name>/` (for example `title-summarizer/`). Keep helpers, provider clients, tools, and persistence helpers inside that folder.
2. Implement tools using the shared `Automation` interface from `src/automations/types.ts`.
3. Export the automation's public API from `src/automations/<automation-name>/index.ts` and re-export from `src/automations/index.ts`.
4. Register built-in tools in `src/automations/registry.ts` (or call `registerTypedAutomation` from module init code).
5. Add colocated unit tests under the automation folder or next to shared module files.
6. Document provider secrets in `.env.example` if the automation needs new environment variables.
7. Update [`docs/01-automations-overview.md`](docs/01-automations-overview.md) with usage notes.

Automations must return `null` when a provider is unavailable or a model call fails so callers can fall back deterministically.

---

## Adding a Persistence Helper

If an automation should update domain state:

1. Define a narrow store interface (see `ObjectiveTitleStore` in `title-summarizer/objectives/generate-objective-title.ts`).
2. Accept the store from the caller — do not import Kysely or database adapters inside `src/automations/`.
3. Keep fire-and-forget helpers async-safe: swallow/log provider errors, never throw for missing API keys.

---

## File Placement Convention

```
automations/
  docs/
  AGENTS.md
  README.md

src/automations/
  types.ts
  registry.ts
  index.ts
  title-summarizer/          # one folder per automation
    config.ts
    gemini-client.ts
    helpers/
    tools/
    objectives/
    index.ts
```

---

## Cross-Module Checklist

- [ ] Read `CONTRACT.md` Automations Layer and `serviceToAutomations` surface
- [ ] No direct database access from `src/automations/`
- [ ] New secrets documented in `.env.example`
- [ ] Colocated tests for fallback and happy-path behavior
- [ ] Contract update only if you add a new interaction surface or stable interface
