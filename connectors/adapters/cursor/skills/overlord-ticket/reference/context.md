# Context And Artifacts

```bash
ovld protocol read-context --session-key <sessionKey> --ticket-id $TICKET_ID
ovld protocol write-context --session-key <sessionKey> --ticket-id $TICKET_ID --key "key" --value '"json-value"'
ovld protocol attachment-list --session-key <sessionKey> --objective-id <objective-id>
ovld protocol attachment-upload-file --session-key <sessionKey> --objective-id <objective-id> --file ./spec.pdf --content-type application/pdf
ovld protocol attachment-download-url --session-key <sessionKey> --attachment-id <attachment-id>
```

The `attach` and `load-context` responses already include `attachments` and `objectives` arrays — use those for `<attachment-id>` and `<objective-id>` values. Run `attachment-list` mid-session if new files have been uploaded since attach. `--ticket-id` is optional for attachment calls when `--objective-id` or `--attachment-id` lets the server derive the ticket.

## Large Artifacts

For large artifacts such as planning documents, architecture decisions, research summaries, or design documents: **save the full content as a markdown file in the linked repository, then summarize it in the artifact returned to the ticket.**

- Save to a meaningful path in the repository (e.g., `ai/feature-plans/my-feature.md` for feature plans, `docs/decisions/my-decision.md` for architecture decision records).
- Commit the file as part of the ticket's work so it appears in `changeRationales`.
- In the delivery, include a `note` or `decision` artifact with a concise summary and the repository file path — not the full document content.

This keeps the ticket feed readable while preserving the full document in version control where it can be reviewed, diffed, and referenced later.

