# Claude Prompt Wrapper

Claude launch prompts should keep the mission objective compact and place large context in a file that Claude receives through its native context flag.

Recommended launch shape:

```bash
claude --append-system-prompt-file <context-file> --model <model> --effort <level> "Begin working on this mission."
```

Rules:

- The context file should contain the Overlord mission prompt, objective metadata, history, artifacts, attachments, and shared context assembled by the protocol layer.
- The visible user prompt should point Claude at the context file and name the active mission ID; for normal execution this is a short instruction such as `Begin working on this mission.`
- `--model` is passed only when the execution target has a model configured.
- `--effort` is passed only when the installed Claude binary supports it and the execution target has an effort level configured.
- Do not embed secrets in the prompt wrapper. Authentication comes from shared `ovld auth` credentials, Overlord-launched environment variables, `Overlord_USER_TOKEN` / `OVLD_USER_TOKEN`, or the Claude plugin `user_token` config passed to `ovld protocol` as `Overlord_USER_TOKEN`.
