# PI Prompt Wrapper

PI receives Overlord's generated mission context as a native file input and a short visible launch message:

```bash
pi --model <provider/id> --thinking <level> @<context-file> "Start work on <mission>."
```

Rules:

- Pass the selected provider-qualified model unchanged with `--model`; do not split it into `--provider` plus a bare model ID.
- Pass thinking separately with `--thinking` only when the selected launch configuration specifies it.
- Place user-configured launch flags before the `@<context-file>` and visible message arguments.
- The context file contains the mission, objectives, history, artifacts, attachments, and lifecycle instructions. Do not put credentials in it.
