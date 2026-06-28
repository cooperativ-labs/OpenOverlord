# Upgrading after the client checkout bridge

If your workspace was created on **Overlord Cloud** before the client checkout
bridge shipped, you may have execution targets stamped with the **hosted backend
container hostname** instead of your Mac or desktop device. Those targets cannot
run checkout-local work (git, filesystem, branch actions).

## Detect stale targets

Run:

```bash
ovld doctor
```

When authenticated against a hosted backend, `ovld doctor` warns if any execution
target fingerprint matches the backend/container host. You can also call:

```http
GET /api/diagnostics/execution-target-migration
```

(requires workspace read permission).

## Fix affected workspaces

1. **Re-select your client device** — In the web app, open **Project Settings →
   Resources** and choose your Mac/desktop device in the execution target
   selector (not the hosted backend host).
2. **Re-link the primary resource** — Link the primary repository again with the
   correct `executionTargetId` for your client device.
3. **Clear stale queued work** — Cancel or re-queue `execution_requests` that
   still reference the old backend-host target so runners can claim them on your
   client device.

See [`database/docs/scripts/fix-stale-backend-execution-targets.sql`](../database/docs/scripts/fix-stale-backend-execution-targets.sql)
for optional admin SQL to list or clear orphaned queue rows.

## Release notes (client checkout bridge)

- Checkout-local operations (repository tree, branch list/actions, worktrees,
  `@` mentions) now run on the **client execution target** via the desktop
  bridge — not on the hosted backend.
- Workspaces with backend-host execution targets must migrate using the steps
  above.
- Browser-only Cloud use remains **degraded** (see product decisions in
  [`planning/feature-plans/client-checkout-bridge-unification.md`](../planning/feature-plans/client-checkout-bridge-unification.md)
  §12).
