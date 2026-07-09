# coo:187 — Optimize JavaScript Bundle Sizes

## Problem

Vite production build warned that chunks exceeded 500 kB after minification:

| Chunk | Before (min) | Before (gzip) |
| --- | ---: | ---: |
| `vendor-react` | 194 kB | 61 kB |
| `vendor-base-ui` | 195 kB | 63 kB |
| `vendor` (catch-all) | 471 kB | 108 kB |
| `bootstrap-app` | 535 kB | 137 kB |

## Root causes

1. **All page routes were statically imported** from `router.tsx`, so the entire SPA UI landed in `bootstrap-app`.
2. **Catch-all `manualChunks`** dumped `better-auth`, `zod`, floating-ui, and misc deps into one `vendor` chunk.
3. **Webapp imported `@overlord/automations` root barrel**, which re-exports Gemini title tools and pulled `@google/genai` (~large) into the SPA graph even though the UI only needed lifecycle/scheduling helpers.

## Changes

1. Added browser-safe package subpaths:
   - `@overlord/automations/objective-manager`
   - `@overlord/automations/scheduling-engine`
2. Pointed webapp imports at those subpaths; documented the rule in `CONTRACT.md` and automations overview.
3. Split Vite `manualChunks` into `vendor-auth`, `vendor-zod`, `vendor-ui-utils`, plus existing react/tanstack/dnd/base-ui/icons buckets.
4. Switched route page components to `lazyRouteComponent(() => import(...))` so boards, mission panel, and secondary pages load on demand (`defaultPreload: 'intent'` preserved).

## Results

| Chunk | After (min) | After (gzip) |
| --- | ---: | ---: |
| `bootstrap-app` | 347 kB | 87 kB |
| `vendor` (catch-all) | 9 kB | 3.5 kB |
| `vendor-auth` | 24 kB | 9 kB |
| `vendor-base-ui` | 195 kB | 63 kB |
| `vendor-react` | 194 kB | 61 kB |
| Largest route chunk (`MissionPanel`) | 92 kB | 25 kB |

- Vite **500 kB chunk warning cleared**.
- Service worker precache dropped ~1735 KiB → ~1364 KiB.
- `@google/genai` no longer appears in any SPA JS asset.
