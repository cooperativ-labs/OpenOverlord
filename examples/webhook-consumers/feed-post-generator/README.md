# Example: feed-post generator (Overlord webhook consumer)

A complete, runnable webhook consumer that rebuilds the upstream Overlord
`generate-feed-post` pipeline as independent software, driven by an Overlord
mission-data webhook instead of living inside the Overlord repository. See
[`docs/webhooks.md`](../../../docs/webhooks.md) for the full contract this
implements.

This directory is **not** part of the Overlord Yarn workspace — it's meant to
be copied out and run as its own service.

## What it does

1. Receives a signed `POST` at `/webhooks/overlord` on `mission.delivered`.
2. Verifies the HMAC signature (rejecting stale timestamps).
3. If the subscription is `thin`, pulls the full mission via the REST API with
   a `USER_TOKEN`; if `full`, the context is already inline.
4. Drafts a one-line feed post — via Gemini if `GEMINI_API_KEY` is set, or a
   deterministic fallback otherwise (never blocks on an unavailable provider).
5. Appends the result to `feed-posts.jsonl` as a stand-in for "post it
   somewhere else" (a CMS, a Slack channel, a database — swap in your own
   sink).

## Setup

```bash
cd examples/webhook-consumers/feed-post-generator
npm install
```

Create a webhook subscription in **Settings → Webhooks** (or `POST
/api/webhooks`) pointing at this service, for event type `mission.delivered`.
Copy the secret it shows you.

```bash
export OVERLORD_WEBHOOK_SECRET=whsec_...        # from the subscription you just created
export OVERLORD_BACKEND_URL=http://127.0.0.1:4310   # your Overlord backend
export OVERLORD_USER_TOKEN=out_...              # only needed for a `thin` subscription
export GEMINI_API_KEY=...                       # optional; omit for the deterministic fallback

npm start
```

Point the subscription's endpoint URL at this service (e.g.
`http://localhost:8787/webhooks/overlord` if colocated — add that host to
`OVERLORD_WEBHOOK_INTERNAL_HOSTS` on the backend, or expose it over HTTPS if
external). Click **Send test delivery** in the create dialog to confirm
wiring, then deliver a real mission to see a line appended to
`feed-posts.jsonl`.

## Extending it

- Swap `draftFeedPost` for any LLM provider.
- Swap the `appendFile` sink for a real destination (CMS API, database,
  Slack).
- Add more event types (`mission.status_changed`, `objective.completed`,
  `mission.blocked`) to react to other lifecycle moments — a memory-system
  ingester or a "trigger a production test" automation would branch on
  `envelope.type` the same way this file does.
