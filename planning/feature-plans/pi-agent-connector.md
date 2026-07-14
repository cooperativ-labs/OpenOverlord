# PI Agent Connector — Implementation Plan

Mission: `coo:308` — *Integrate PI Agent Connector*

Date: 2026-07-14

## TL;DR

1. Add `pi` as a built-in connector using the existing custom-connector extension point. Install an Agent Skills-compatible Overlord skill plus a small PI extension under `~/.pi/agent/`; do not duplicate the connector core.
2. Add PI to the bundled workspace agent catalog so every catalog-driven launch surface (mission/objective selectors, quick task, workspace Models settings, runner queue) receives it automatically.
3. Pass PI a provider-qualified `--model <provider/id>` and a separate `--thinking <level>`. Seed `zai/glm-5.2`, `anthropic/claude-opus-4-8`, and `openai-codex/gpt-5.6-terra` as the three default model options.
4. Add PI-specific launch and native-resume mappings, connector setup/doctor coverage, catalog/launch tests, documentation, and packaged-CLI smoke coverage.
5. No database, REST, or contract-version change is required. PI uses the existing Connector → Protocol hook surface and approved connector capabilities.

## Research findings

### PI installation and extension surface

- PI's executable is `pi`; the current `resolveAgentBinary()` fallback already resolves an unknown connector key to a same-named executable, though adding an explicit `pi: 'pi'` entry makes the built-in mapping auditable.
- PI discovers Agent Skills from `~/.pi/agent/skills/` and `~/.agents/skills/`. A connector adapter can therefore install `skills/overlord-mission/SKILL.md` with the existing `<!-- @connector-core -->` interpolation mechanism.
- PI discovers user extensions from `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/*/index.ts`. Its `input` event exposes raw user text, input source, and whether the message is a steer or queued follow-up. Its session manager exposes the native session ID.
- PI intentionally has no built-in permission prompt. The connector must not claim `permissionHook`; a `tool_call` event is not itself a human permission request.
- PI supports `--session <path|id>` for non-interactive native resume, making `pi --session <sessionId>` suitable for Overlord's review-session affordance.

Official references:

- [Using PI / CLI reference](https://pi.dev/docs/latest/usage)
- [PI skills](https://pi.dev/docs/latest/skills)
- [PI extensions and input events](https://pi.dev/docs/latest/extensions)
- [PI sessions](https://pi.dev/docs/latest/sessions)
- [PI model catalog](https://pi.dev/models)

### Model selection

PI supports these independent launch options:

```text
--provider <name>
--model <pattern-or-id>
--thinking <off|minimal|low|medium|high|xhigh|max>
```

`--model` accepts `provider/id` and also accepts a `:thinking` suffix. Overlord should use the provider-qualified form and continue passing thinking separately because its selector and persistence model already store `objectives.model` and `objectives.reasoning_effort` independently. Combining them into one string would make the UI and queued launch snapshot drift.

Default PI catalog entries:

| Display name | Overlord model ID passed to PI | Provider/auth route | Recommended thinking choices |
| --- | --- | --- | --- |
| GLM 5.2 | `zai/glm-5.2` | Z.AI coding API | `off`, `high`, `max` |
| Claude Opus 4.8 | `anthropic/claude-opus-4-8` | Anthropic / Claude login | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-5.6 Terra | `openai-codex/gpt-5.6-terra` | ChatGPT Codex subscription | `off`, `low`, `medium`, `high`, `xhigh`, `max` |

These are deliberately provider-qualified. PI has several routes for each popular model, so an unqualified ID can be ambiguous or resolve differently as the user's authenticated providers change. Workspace admins can still add alternative routes such as `openai/gpt-5.6-terra` or `nvidia/z-ai/glm-5.2` through the existing agent catalog editor.

Model references:

- [GLM-5.2 on Z.AI](https://pi.dev/models/zai/glm-5-2)
- [Claude Opus 4.8 on Anthropic](https://pi.dev/models/anthropic/claude-opus-4-8)
- [GPT-5.6 Terra on OpenAI Codex](https://pi.dev/models/openai-codex/gpt-5-6-terra)

## Current Overlord integration points

| Concern | Existing owner/source | PI change |
| --- | --- | --- |
| Built-in agent and models | `cli/src/agent-catalog-defaults.ts` | Add a `pi` catalog entry. Existing backend seed/refresh behavior will expose it through `/api/agent-catalog`. |
| Binary resolution | `cli/src/agent-binaries.ts` | Add explicit `pi: 'pi'`. |
| Launch argument mapping | `cli/src/launch.ts` | Add a PI branch that maps model to `--model`, reasoning to `--thinking`, and includes the generated mission context file in the initial message. |
| Setup and doctor | `cli/src/connectors.ts`, manifest-driven discovery | Add `connectors/adapters/pi/`; generic setup/doctor should work without a PI-only settings mutation. |
| Connector packaging | `cli/scripts/build.mjs` | No new copy mechanism; the build already copies the entire `connectors/` tree into the CLI package. |
| Agent UI | Catalog-driven selectors and settings | No new selector component. `pi.svg` and the `pi` icon mapping already exist. |
| Native review resume | `webapp/web/lib/helpers/agent-resume-command.ts` | Add `pi --session <id>`. |
| Native session capture | connector extension → `ovld protocol hook-event` | Report `ctx.sessionManager.getSessionId()` as `externalSessionId` and populate the existing native-session cache. |
| Documentation/help | `connectors/README.md`, adapter README, CLI help | List PI as built in and document auth/model behavior. |

## Contract decision

This is a new shipped connector under the existing `custom-connector` extension point. It needs a `conformance-manifest.yaml`, but no `CONTRACT.md`, `contract/components.yaml`, or contract-version change, provided implementation stays within the approved set:

- Capabilities: `followUpHook`, `nativeResume`, `modelFlag`, `effortFlag`.
- Hook types: `UserPromptSubmit` only.
- Interaction surface: Connector → Protocol via `ovld protocol hook-event`.

Do not claim `permissionHook`, `permissionRules`, or `slashCommands` in the first release. PI has no native permission-request event, and PI extension commands are not needed to satisfy the mission workflow because the Agent Skill and `ovld protocol` CLI already provide it. Slash commands can be added later if implemented and tested.

## Implementation plan

### Phase 1 — Connector adapter

Create `connectors/adapters/pi/` with:

```text
connectors/adapters/pi/
  conformance-manifest.yaml
  README.md
  prompt-wrapper.md
  extensions/overlord.ts
  skills/overlord-mission/SKILL.md
```

The manifest should:

- Use `componentType: connector`, `componentKey: pi`, and `agentIdentifier: pi`.
- Install at `~/.pi/agent`.
- Declare the four capabilities and one hook type above.
- List the PI extension, adapter skill, prompt wrapper, and rendered connector-core references as managed files.
- Validate with `ovld contract check connectors/adapters/pi/conformance-manifest.yaml`.

The PI skill should contain only PI-specific notes around the `<!-- @connector-core -->` marker:

- Agent identifier is `pi`.
- PI model selection is `--model provider/id`; thinking is `--thinking level`.
- The installed extension records normal user follow-ups and native session IDs.
- PI has no native permission-prompt hook, so the agent must not claim permission activity is captured automatically.
- Shared `ovld` authentication and lifecycle rules remain owned by connector core.

The PI extension should:

1. Subscribe to `session_start` and `input`.
2. Read `MISSION_ID` / `OVERLORD_MISSION_ID` and ignore non-Overlord sessions.
3. Obtain the native ID from `ctx.sessionManager.getSessionId()` and write the same `~/.ovld/native-sessions/<hash>` record used by other connectors.
4. Skip the launch-injected first input when `OVERLORD_EXECUTION_REQUEST_ID` is present, preventing the mission context from being recorded as a follow-up.
5. Ignore `event.source === 'extension'` and empty text.
6. Send subsequent interactive/RPC inputs to `ovld protocol hook-event --hook-type UserPromptSubmit`, including mission ID, prompt, monotonic turn index, and external session ID. Use `pi.exec()` or a detached child process; hook failure must never block PI's input pipeline.
7. Preserve PI's input unchanged by returning `continue`.

The adapter README must document `ovld agent-setup pi`, PI installation, `/login` or API-key authentication, the provider-qualified model IDs, native resume, managed files, and the absence of permission capture.

### Phase 2 — Launch and model catalog

Update `cli/src/agent-catalog-defaults.ts` with a `pi` entry:

- Label: `PI`.
- `availableByDefault: true`.
- The three provider-qualified models above.
- `reasoningLabel: 'Thinking'`.
- Keep `defaultModel: null` so PI can use its own configured default when the user chooses the selector's existing **Default** option. The three requested entries remain immediately selectable.

Update `cli/src/launch.ts` with an explicit PI command builder:

```text
pi [--model provider/id] [--thinking level] [...user flags] @<context-file> <launch-message>
```

Using PI's documented `@file` input includes the generated mission context without stuffing a large system prompt into argv. Keep `model` and `thinking` separate and place user launch flags before the initial message/file arguments.

Update `cli/src/agent-binaries.ts` with the explicit `pi` binary mapping. No protocol, REST, database, or runner queue changes are needed: the existing request fields already carry arbitrary agent/model/reasoning strings to the launcher.

### Phase 3 — App-wide and native resume surfaces

The app's selectors consume `/api/agent-catalog`, so adding the bundled catalog entry makes PI available in:

- New mission and quick-task agent selection.
- Objective agent/model/reasoning selection.
- Workspace Settings → Models availability and customization.
- Project user launch preference persistence.
- Runner execution requests and manual `ovld launch pi`.

No icon change is needed: `webapp/public/images/icons/pi.svg` and the `pi` entry in `agent-icons.ts` already exist.

Add `pi: sessionId => 'pi --session <sessionId>'` to `webapp/web/lib/helpers/agent-resume-command.ts`. The extension-reported session ID flows through the existing `objectives.external_session_id` / native-session machinery, so the review UI can show the same “resume conversation” affordance as other native-resume connectors.

Update static discoverability surfaces:

- `connectors/README.md` setup examples and connector bundle list.
- `connectors/docs/05-connectors-and-agent-plugins.md` with a PI connector section and launch mapping.
- CLI help's built-in agent list.
- Packaged CLI smoke-test expectation for `ovld agent-setup --json`.

After connector files change, run the repository's connector version workflow (`yarn connectors:version:bump`) as required by `connectors/AGENTS.md`.

### Phase 4 — Verification

Add or extend tests for:

1. **Manifest/admission:** PI appears in `listAvailableConnectors()`, every managed file resolves, declared capabilities/hooks are contract-approved, and the manifest passes `ovld contract check`.
2. **Setup/doctor:** `setupConnector({ agentKey: 'pi' })` writes only under the temporary home's `.pi/agent`, is idempotent, detects missing/modified files, and reports the `pi` binary accurately.
3. **Extension behavior:** a stubbed `ovld` receives no event for the injected first turn, receives one `UserPromptSubmit` event for the next interactive input, includes the PI session ID, preserves text verbatim, and does not block when `ovld` fails.
4. **Launch mapping:** dry-run plan snapshots verify provider-qualified `--model`, separate `--thinking`, user flags, `@contextFile`, and mission environment variables.
5. **Catalog:** PI and the exact three model IDs survive bundled-catalog parsing, backend seeding, and refresh-merge without overwriting workspace customizations.
6. **UI helper:** native resume produces `pi --session <id>` and remains null without a session ID.
7. **Packaged CLI:** the built package lists `pi` and includes its adapter files outside the source checkout.

Run the focused checks first, then the repository-required suites:

```text
yarn connectors:version:check
ovld contract check connectors/adapters/pi/conformance-manifest.yaml
node --test cli/test/setup-doctor.test.ts cli/test/launch.test.ts cli/test/config.test.ts
node --test webapp/web/lib/helpers/agent-resume-command.test.ts
```

Use the repository's standard build/test commands for the final full verification; do not rewrite or discard unrelated dirty files while doing so.

## Acceptance criteria

- [ ] `ovld agent-setup pi` installs an idempotent PI connector and `ovld doctor` can diagnose it.
- [ ] `ovld agent-setup --json` and packaged builds list `pi`.
- [ ] PI appears in every catalog-driven agent selector with GLM 5.2, Opus 4.8, and GPT-5.6 Terra.
- [ ] Selecting a PI model launches `pi --model <provider/id>` with the exact provider-qualified ID.
- [ ] Selecting reasoning launches `pi --thinking <level>` separately; choosing Default omits both flags as appropriate.
- [ ] PI receives the full generated Overlord mission context and follows the shared connector-core lifecycle.
- [ ] Normal follow-up prompts are recorded once, the injected launch prompt is not recorded as a follow-up, and connector failure never blocks user input.
- [ ] PI's native session ID is recorded and the review UI offers `pi --session <id>`.
- [ ] No unsupported permission-hook claim, database change, REST endpoint, new hook type, capability flag, or contract bump is introduced.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Unqualified model IDs resolve through an unintended provider | Store provider-qualified IDs in the PI catalog and pass them unchanged. |
| PI's first CLI input is mistaken for a human follow-up | Explicitly skip the first input for an Overlord execution request and cover it behaviorally. |
| PI extension failure delays or blocks user input | Make hook publication fire-and-forget with bounded execution and always return `continue`. |
| Workspace catalogs were seeded before PI shipped | Existing `POST /api/agent-catalog/refresh` merge behavior adds missing agents/models while preserving edits; verify this in tests and document refresh behavior. |
| Requested model is unavailable because its provider is not authenticated | Keep catalog availability separate from provider auth; PI reports availability/auth at launch, and the adapter README points users to `/login`, environment keys, and `pi --list-models`. |
| Connector declares capabilities PI does not actually expose | Limit v1 claims to model, thinking, follow-up, and native resume; validate the manifest and admission tests. |

## Deferred follow-ups

- PI-specific slash commands wrapping common `ovld protocol` operations. The skill plus CLI is sufficient for v1.
- A permission policy extension. This should be designed as an actual user gate, not mislabeled as PI-native permission capture.
- Dynamic synchronization of PI's full provider/model catalog. Overlord's workspace catalog is intentionally curated; `pi --list-models` remains the source for provider-specific discovery.
- Additional default provider routes (OpenRouter, NVIDIA, direct OpenAI) if users want them preseeded rather than workspace-customized.
