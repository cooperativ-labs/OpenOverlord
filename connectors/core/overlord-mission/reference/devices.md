# Execution Targets And Checkout Paths

Execution targets are canonical rows keyed by a real device fingerprint when known, or by a placeholder until the target registers. Organization labels, user access, project membership, and project checkout paths live in separate association rows. Agents do not manage these rows through `ovld protocol`.

```bash
ovld create-project --name "My Project"
ovld add-cwd --project-id <project_id_or_name>
ovld runner status
```

`ovld runner start` uses the configured backend's `/api/runner/*` management endpoints and the local execution target identity to claim queued execution requests from manual Run and auto-advance. Primary resource directories are scoped per `(project, execution target)`. `ovld runner once` claims at most one request and exits.

## Choosing `--for-human`

Pass `--for-human agent` or `--for-human human` (default: `human`) when creating missions.

- **`agent`** — any task an AI agent can complete in a computer environment: coding, internet research, document editing, data analysis, automated testing, etc.
- **`human`** — any task requiring human presence or judgment: setting credentials or tokens in a third-party UI (e.g. Vercel, AWS), sending physical mail, making a product or business decision, physical-world actions.

When in doubt, ask yourself: _can this be done entirely inside a terminal or browser by an AI without human intervention?_ If yes → `agent`. If it requires a human to log in, decide, or act in the real world → `human`.
