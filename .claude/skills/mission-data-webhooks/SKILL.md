---
name: mission-data-webhooks
description: Points to the user-facing documentation and reference example for Overlord's mission-data webhooks feature. Invoke when building, debugging, or explaining a webhook consumer, when asked how to receive mission events (delivery, status change, blocked) outside this repository, or when touching webhook_subscriptions/outbox_messages/webhook-dispatcher code.
---

# Mission Data Webhooks

Overlord can push signed HTTP deliveries to an external endpoint on mission events, so independent
software (a feed-post generator, a memory ingester, a production-test trigger, anything else) can
react without living inside this repository or its runtime.

**Read [`docs/webhooks.md`](../../../docs/webhooks.md) before doing any of the following:**

- Building or debugging a webhook consumer (signature verification, payload envelope, retry/
  idempotency semantics, thin-vs-full payload mode, the REST pull path for anything a `thin`
  payload omits).
- Answering a user's question about how to receive mission events outside Overlord.
- Explaining or modifying webhook management (`Settings → Webhooks`, `/api/webhooks*`).

A complete, runnable reference consumer lives at
[`examples/webhook-consumers/feed-post-generator/`](../../../examples/webhook-consumers/feed-post-generator/README.md)
— it rebuilds the upstream Overlord `generate-feed-post` pipeline as ordinary external software
driven by this webhook, and is the pattern to point users at when they ask "how do I build a
consumer."

## If you are implementing inside this repository

The feature's own architecture doc is
[`planning/feature-plans/mission-data-webhooks-api.md`](../../../planning/feature-plans/mission-data-webhooks-api.md).
Key source files, in the order an event flows through them:

1. `packages/core/service/webhook-events.ts` — `enqueueWebhookEvent()` (the shared-single-writer
   enqueue helper, called from both the protocol service core and the REST data layer) and
   `buildWebhookEnvelope()` (thin/full envelope hydration).
2. `backend/webhook-dispatcher.ts` — the in-process, `RealtimeHub`-style polling worker that claims
   `outbox_messages` rows and delivers HMAC-signed HTTP POSTs with retry/backoff.
3. `backend/webhook-security.ts` — SSRF guard, `OVERLORD_WEBHOOK_INTERNAL_HOSTS` internal-host
   detection, and Stripe-style signature generation.
4. `backend/webhooks.ts` + the `/api/webhooks*` routes in `backend/index.ts` — subscription
   management (list/create/update/delete/rotate-secret/test/deliveries/redeliver).
5. `webapp/web/components/settings/WebhooksPage.tsx` — the management UI.

Adding a new webhook event type or touching the tables (`webhook_subscriptions`,
`webhook_delivery_attempts`, `outbox_messages`) is a cross-module change — read `CONTRACT.md` and
the database schema contract's "Webhook event catalog" section first, per the `component-contract`
skill.

<!-- version: 1.0.0 -->
