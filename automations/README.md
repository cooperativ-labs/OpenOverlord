# Automations Module

Optional AI automations for Open Overlord. Developers register simple automations behind
a shared `Automation` interface; the reference implementation is Gemini-backed text
summarization and objective title generation.

## Contract Component

Maps to the **Automations Layer** (`automations`) in [`CONTRACT.md`](../CONTRACT.md), which owns:

- The `Automation` interface and built-in automation registry
- Gemini provider configuration (`GEMINI_API_KEY`, optional `GEMINI_MODEL`)
- Reference summarization automations
- Fire-and-forget helpers that persist results through caller-supplied store interfaces

It does **not** own database schema, ticket/objective lifecycle, or agent protocol
behavior.

## Documentation

- [01 — Automations Overview](docs/01-automations-overview.md): automation model, Gemini setup, and extension guide
- [Test Plan](docs/testing.md): unit coverage for title derivation, fallbacks, and registry behavior

## Code & Tests

Implementation lives under [`../src/automations/`](../src/automations):

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

- `src/automations/title-summarizer/helpers/title.test.ts`
- `src/automations/title-summarizer/objectives/generate-objective-title.test.ts`
- `src/automations/registry.test.ts`

## Configuration

Copy [`.env.example`](../.env.example) to `.env` and set `GEMINI_API_KEY` to enable
Gemini-backed automations. When the key is missing or a call fails, automations return `null` and
callers should use deterministic local fallbacks (see `deriveTitleFromInstructionText`).

## Interaction Boundaries

Other components consume automations only through the exported API in `src/automations/`.
Persistence must go through injected callbacks such as `ObjectiveTitleStore`; the
module must not read or write domain tables directly.
