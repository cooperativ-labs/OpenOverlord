# Automations Overview

Plan for the Open Overlord automations module. This document is the reference spec for
contract component `automations`.

## Goals

- Give developers a small, explicit interface for optional AI automations.
- Ship a reference Gemini summarization tool patterned on upstream Overlord's
  `generate-ticket-title.ts`.
- Show how service-layer callers wire automations through injected persistence
  callbacks, matching upstream `generateAndSetObjectiveTitle` in `objectives.ts`.

## Automation Model

Every automation implements `Automation<TInput, TOutput>`:

```ts
type Automation<TInput, TOutput> = {
  id: string;
  label: string;
  description: string;
  run: (params: { input: TInput; context?: AutomationRunContext }) => Promise<TOutput | null>;
};
```

Built-in automations register in `automations/src/registry.ts`. Callers can also register
custom automations with `registerAutomation` during module initialization.

## Built-In Automations

| Automation ID | Purpose |
| --- | --- |
| `summarize-text` | Generic Gemini summarization with optional length cap |
| `summarize-objective-title` | Short action-oriented title from objective instruction text |

Both automations return `null` when `GEMINI_API_KEY` is unset or the provider call fails.

## Objective Title Automation

`generateObjectiveTitle` mirrors upstream behavior:

1. Trim instruction text; return empty for blank input.
2. For text at or below `AI_TITLE_THRESHOLD` (100 chars), derive locally via `deriveTitleFromInstructionText`.
3. For longer text, optionally call Gemini when `aiTitleGenerationEnabled` is true.
4. Fall back to local derivation when Gemini is unavailable.

`generateAndSetObjectiveTitle` wraps the same logic and persists through an injected
`ObjectiveTitleStore` so the automations module stays decoupled from Kysely/Supabase.

Example caller wiring:

```ts
import { generateAndSetObjectiveTitle } from '../automations/index.js';

void generateAndSetObjectiveTitle({
  store: {
    updateObjectiveTitle: async ({ objectiveId, title }) => {
      await db
        .updateTable('objectives')
        .set({ title, updated_at: new Date().toISOString() })
        .where('id', '=', objectiveId)
        .execute();
    }
  },
  objectiveId,
  instructionText,
  aiTitleGenerationEnabled: true
});
```

## Configuration

Environment variables (see [`.env.example`](../../.env.example)):

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | No | — | Enables Gemini-backed automations when set |
| `GEMINI_MODEL` | No | `gemini-2.5-flash-lite` | Model identifier for summarization calls |
| `OVERLORD_AUTOMATIONS_MODULE` | No | — | Comma-separated downstream automation bundle(s) loaded at boot (see [Downstream Automations](#downstream-automations)) |

## Layout

Each automation is self-contained in its own folder under `automations/src/`. The reference
`title-summarizer` automation owns its Gemini client, helpers, tools, and objective title
persistence helpers. Shared module code (`types.ts`, `registry.ts`, `index.ts`) stays at the
`automations/src/` root.

## Extension Guidelines

1. Add new automations as folders under `automations/src/<automation-name>/`.
2. Keep provider clients inside the automation folder (do not leak `@google/genai` into other modules).
3. Document any new secrets in `.env.example`.
4. Never import database adapters from automations — pass store interfaces from callers.

## Downstream Automations

The `custom-automation` extension point lets a repo that tracks OpenOverlord
upstream register its own automations **without editing this module**, so those
edits never collide with upstream changes on merge.

- Build a small module that calls `registerAutomation` / `registerAutomations`
  (re-exported from `@overlord/automations`) at import time.
- Point `OVERLORD_AUTOMATIONS_MODULE` at it (comma-separated package names or
  paths for more than one). The server imports each module for its side effects
  at boot via `loadExternalAutomations()` and logs the ids it registered.

```ts
// @your-org/overlord-automations — loaded only when the env var points at it.
import { registerAutomations } from '@overlord/automations';

registerAutomations([
  { id: 'acme:triage', label: 'Triage', description: '…', run: async () => null }
]);
```

Do **not** add downstream automations to `builtInAutomations` in
`registry.ts` — that array is upstream-owned and the env-var seam exists
precisely to keep it conflict-free.
