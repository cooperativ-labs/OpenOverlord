# Codex Prompt Wrapper

Codex launch prompts should keep the mission objective compact and pass model and reasoning effort through native Codex flags when configured.

Recommended launch shape:

```bash
codex [--model <model>] [-c model_reasoning_effort="<level>"] "Begin working on this mission."
```

Rules:

- The assembled Overlord mission prompt, objective metadata, history, artifacts, attachments, and shared context should be injected as the initial session prompt by the protocol layer.
- The visible user prompt should name the active mission ID; for normal execution this is a short instruction such as `Begin working on this mission.`
- `--model` is passed only when the execution target has a model configured.
- `-c model_reasoning_effort="<level>"` is passed only when the execution target has an effort level configured.
- For large context, write a context file and pass a short prompt that points Codex at it.
- Do not embed secrets in the prompt wrapper. Authentication comes from shared `ovld auth` credentials, Overlord-launched environment variables, or `Overlord_USER_TOKEN` / `OVLD_USER_TOKEN`.
