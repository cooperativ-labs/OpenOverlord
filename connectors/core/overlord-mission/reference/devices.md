# Execution Targets And Checkout Paths

Execution targets are canonical rows keyed by a real `device_fingerprint` when known, or by a placeholder until the target registers. Organization labels, user access, project membership, and project checkout paths live in separate association rows. Persist a fingerprint per machine, upsert via `ovld protocol get-device`, then maintain checkout paths via `list-project-resources`, `add-project-resource`, `update-project-resource`, and `update-device` (`ovld protocol help` lists flags). To create a brand-new project (optionally registering a directory as its primary resource in one step) use `ovld protocol create-project --name "..."`.

```bash
ovld protocol get-device --device-fingerprint "$OVERLORD_DEVICE_FINGERPRINT"
ovld protocol list-project-resources --project-id <project_uuid> --device-fingerprint "$OVERLORD_DEVICE_FINGERPRINT"
```

`ovld runner start` uses the same execution target identity and project resource directories to claim queued execution requests from manual Run and auto-advance. Primary resource directories are scoped per `(project, execution target)`. `ovld runner once` claims at most one request and exits.

## Choosing `--for-human`

Pass `--for-human agent` or `--for-human human` (default: `human`) when creating missions.

- **`agent`** — any task an AI agent can complete in a computer environment: coding, internet research, document editing, data analysis, automated testing, etc.
- **`human`** — any task requiring human presence or judgment: setting credentials or tokens in a third-party UI (e.g. Vercel, AWS), sending physical mail, making a product or business decision, physical-world actions.

When in doubt, ask yourself: _can this be done entirely inside a terminal or browser by an AI without human intervention?_ If yes → `agent`. If it requires a human to log in, decide, or act in the real world → `human`.

