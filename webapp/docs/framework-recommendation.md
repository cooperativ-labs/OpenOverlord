# Web Framework Recommendation

## Recommendation

Build the first Overlord web interface as a **client-rendered React SPA**
using:

- Vite
- React + TypeScript
- TanStack Router
- TanStack Query
- Serwist via `@serwist/vite`
- Shadcn/UI
- Tailwind CSS

## Why This Fits Overlord

The current requirements point toward an internal, operational application:

- SEO is not important.
- Rapid initial loads are not the main concern.
- Stable, snappy interactivity after load matters a lot.
- Realtime status updates from the database are central to the UX.
- The app should remain compatible with Serwist-based PWA behavior.

That profile favors a SPA with a clean browser/runtime split from the backend.

### 1. It matches the product shape

Overlord's web UI is a control plane for projects, missions, objectives,
runner state, and review. This is more like Linear, GitHub Projects, or a local
ops console than a content site. Client-side routing, cached server state, and
realtime subscriptions are a better default fit than server rendering.

### 2. It preserves the existing architecture

The repo already treats the web layer as a consumer of shared application
services and the REST/realtime boundary, not as a separate source of truth. A
Vite SPA keeps that separation clean:

- browser app consumes REST + SSE/WebSocket
- backend owns lifecycle transitions and DB writes
- CLI and web stay peers on top of the same services

### 3. It is the simplest path for realtime UI

TanStack Query is a good fit for:

- list/detail caching
- optimistic local mutations where appropriate
- background refetch after reconnect
- invalidation from SSE/WebSocket events
- smooth cross-view consistency for mission/objective data

TanStack Router complements that with typed route params, search state, nested
layouts, and route-level data loading without forcing a server-rendered model.

### 4. It aligns well with Serwist

Serwist currently provides framework-specific packages including both
`@serwist/vite` and `@serwist/next`. For this project, the Vite integration is
the more direct fit because the app does not need Next.js's server-oriented
features. A PWA shell, background update flow, and offline-ready static assets
are straightforward in the Vite path.

### 5. It keeps local-first development cheaper

Overlord is explicitly CLI-first and local-first today. A Vite-based SPA:

- has less framework/runtime surface area
- is easier to run beside a local API process
- avoids React Server Component and SSR-specific complexity
- reduces coupling between app code and deployment assumptions

## Why Not Next.js As The Default

Next.js is a strong framework, but it is optimized for a different default:

- server rendering
- public-page performance and SEO
- integrated full-stack route handlers
- server/client component boundaries

Those are useful when the product needs them, but they are not the primary
constraints in this mission. For Overlord right now, Next.js would likely add
complexity faster than it adds value.

## Practical Initial Shape

If implementation starts now, the first slice should likely look like this:

1. Vite React app under `webapp/`.
2. REST client for mission/project/objective reads and writes.
3. Realtime client using SSE first, with WebSocket optional later.
4. TanStack Query cache keyed around projects, mission lists, mission detail, and
   execution state.
5. Serwist registration for app shell caching and update flow.

## Revisit Conditions

Reconsider the framework choice if any of these become first-order
requirements:

- hosted multi-user deployment becomes the primary mode
- public, indexable pages become important
- mixed server-rendered and client-rendered routes become necessary
- auth/session handling moves deeply into the web framework itself

If that happens, Next.js or another server-oriented React framework may become
the better default.
