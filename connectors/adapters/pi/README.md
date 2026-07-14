# PI Connector

The PI connector installs an Overlord Agent Skill and a small PI extension. It gives PI the shared mission lifecycle instructions, records ordinary follow-up prompts, and exposes PI's native session ID for review-session resume.

## Setup

Install PI separately, then install or refresh this adapter:

```bash
ovld agent-setup pi
ovld doctor
```

The adapter writes only Overlord-managed files under `~/.pi/agent`:

- `extensions/overlord.ts`
- `skills/overlord-mission/`
- `prompt-wrapper.md` and this README

Re-running setup is idempotent. `ovld doctor` reports missing or modified managed files and whether the `pi` binary is on `PATH`.

## Models and thinking

PI accepts provider-qualified models with `--model` and an independent `--thinking` level. The built-in catalog includes:

| Display name | PI model ID |
| --- | --- |
| GLM 5.2 | `zai/glm-5.2` |
| Claude Opus 4.8 | `anthropic/claude-opus-4-8` |
| GPT-5.6 Terra | `openai-codex/gpt-5.6-terra` |

Authenticate the matching PI provider through PI's login/configuration flow or its supported environment variables. Use `pi --list-models` to inspect the models available to the current PI configuration.

## Follow-ups and resume

The extension records human input after the initial Overlord launch prompt through `ovld protocol hook-event`. It never blocks the PI input pipeline if that protocol call fails. PI has no native permission-request hook, so this connector does not report permission prompts.

When PI supplies a native session ID, Overlord's review UI can reopen it with:

```bash
pi --session <session-id>
```
