---
name: pwa
description: Configuring Progressive Web Apps (PWA) with Vite and Serwist for offline support, push notifications, and home screen installation.
---

# PWA with Vite and Serwist

## Instructions

Use this skill when turning a Vite application into a Progressive Web App. Prefer the Vite-native Serwist integration, not Next.js-specific Serwist packages or server actions.

Primary upstream reference: https://serwist.pages.dev/docs/vite

This guidance applies to React, Vue, Svelte, Solid, and vanilla Vite projects. The examples use React where a component is useful, but the service worker, manifest, Vite config, and browser APIs are framework-agnostic.

---

## 1. Install Packages

Install Serwist's Vite plugin, browser registration helper, and runtime package:

```bash
yarn add -D @serwist/vite @serwist/window serwist
```

Equivalent package manager commands:

```bash
npm i -D @serwist/vite @serwist/window serwist
pnpm add -D @serwist/vite @serwist/window serwist
bun add -d @serwist/vite @serwist/window serwist
```

Do not use `@serwist/next`, `@serwist/turbopack`, or `next-pwa` in Vite apps.

---

## 2. Add the Serwist Vite Plugin

Update `vite.config.ts` and keep the existing framework plugin. The service worker source should live in `src/sw.ts`; the built worker should be emitted as `sw.js` at the app root.

```ts
// vite.config.ts
import { serwist } from '@serwist/vite'
import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    serwist({
      swSrc: 'src/sw.ts',
      swDest: 'sw.js',
      globDirectory: 'dist',
      injectionPoint: 'self.__SW_MANIFEST',
      rollupFormat: 'iife',
      disable: mode === 'test',
    }),
  ],
}))
```

For non-React projects, replace `react()` with the local framework plugin:

```ts
// Vue example
import vue from '@vitejs/plugin-vue'

plugins: [
  vue(),
  serwist({
    swSrc: 'src/sw.ts',
    swDest: 'sw.js',
    globDirectory: 'dist',
    injectionPoint: 'self.__SW_MANIFEST',
    rollupFormat: 'iife',
  }),
]
```

Important Vite/Serwist options:

| Option | Recommended value | Why |
| --- | --- | --- |
| `swSrc` | `src/sw.ts` | Keeps source worker code in the app source tree. |
| `swDest` | `sw.js` | Emits `/sw.js`; service worker scope can then cover the whole app. Must end in `.js`. |
| `globDirectory` | `dist` | Matches Vite's default production output directory. |
| `injectionPoint` | `self.__SW_MANIFEST` | Placeholder Serwist replaces with the precache manifest. |
| `rollupFormat` | `iife` | Produces a classic worker compatible with the default registration type. |
| `type` | omit unless needed | Default is classic. Use `type: 'module'` only with `rollupFormat: 'es'`. |
| `disable` | `mode === 'test'` or env-gated | Keeps workers out of test builds without disabling production PWA behavior. |
| `devOptions` | optional | Tune dev worker bundling/minification when testing the SW during `vite dev`. |

Use `base`, `scope`, `swUrl`, and `modifyURLPrefix` only when the app is deployed under a subpath. Keep `/sw.js`, `/manifest.json`, icon URLs, and Vite `base` aligned or installs and offline navigation will fail in production.

---

## 3. TypeScript Configuration

Add Serwist's virtual module types and Web Worker libs. In Vite TypeScript projects this often belongs in `tsconfig.app.json`; otherwise use `tsconfig.json`.

```json
{
  "compilerOptions": {
    "types": ["@serwist/vite/typings"],
    "lib": ["DOM", "DOM.Iterable", "ES2022", "WebWorker"]
  }
}
```

If adding `WebWorker` to the app tsconfig causes conflicts with DOM globals, create a separate `tsconfig.sw.json` for `src/sw.ts` and include worker libs there. Keep `@serwist/vite/typings` available to the client entry that imports `virtual:serwist`.

---

## 4. Ignore Generated Worker Files

Add generated Serwist artifacts to `.gitignore`. The exact output location can vary by Vite/public-dir setup, but these are the common generated files:

```gitignore
# Serwist
public/sw*
public/swe-worker*
dist/sw*
dist/swe-worker*
```

Do not ignore `src/sw.ts`; that is source code.

---

## 5. Create the Service Worker

Create `src/sw.ts`:

```ts
/// <reference lib="WebWorker" />

import { defaultCache } from '@serwist/vite/worker'
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist'
import { Serwist } from 'serwist'

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
  }
}

declare const self: ServiceWorkerGlobalScope

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
})

serwist.addEventListeners()
```

Notes:

- `defaultCache` comes from `@serwist/vite/worker`, not a Next.js package.
- `precacheEntries` must point at `self.__SW_MANIFEST` when `injectionPoint` is `self.__SW_MANIFEST`.
- Keep `serwist.addEventListeners()` after any custom event handlers such as push notification handlers.
- Be conservative with custom runtime caching. Add route-specific caching only when the app has a clear offline requirement and the response is safe to cache.

---

## 6. Register the Service Worker

Register the worker from the client entrypoint using Serwist's virtual module. In React, put this in `src/App.tsx` or a tiny component mounted once by `main.tsx`.

```tsx
// src/PwaRegistration.tsx
import { getSerwist } from 'virtual:serwist'
import { useEffect } from 'react'

export function PwaRegistration() {
  useEffect(() => {
    const register = async () => {
      if (!('serviceWorker' in navigator)) return

      const serwist = await getSerwist()

      serwist?.addEventListener('installed', () => {
        console.info('Service worker installed')
      })

      serwist?.addEventListener('waiting', () => {
        console.info('New service worker is waiting')
      })

      void serwist?.register()
    }

    void register()
  }, [])

  return null
}
```

Mount it once:

```tsx
// src/App.tsx
import { PwaRegistration } from './PwaRegistration'

export default function App() {
  return (
    <>
      <PwaRegistration />
      {/* app routes/components */}
    </>
  )
}
```

Framework-neutral alternative:

```ts
// src/register-pwa.ts
import { getSerwist } from 'virtual:serwist'

export async function registerPwa() {
  if (!('serviceWorker' in navigator)) return

  const serwist = await getSerwist()
  void serwist?.register()
}
```

Then call `void registerPwa()` from `src/main.ts` after the app mounts.

---

## 7. Web App Manifest

Create `public/manifest.json`:

```json
{
  "name": "My App",
  "short_name": "App",
  "description": "A Progressive Web App built with Vite",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#0f172a",
  "icons": [
    {
      "src": "/icons/icon-192x192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-512x512.png",
      "sizes": "512x512",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-512x512-maskable.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
```

Generate icons with a real favicon/PWA icon generator and place them under `public/icons/`. Include at least:

- 192x192 PNG
- 512x512 PNG
- 512x512 maskable PNG with safe padding
- Apple touch icon, commonly 180x180
- Optional monochrome SVG mask icon

For apps deployed below domain root, update `start_url`, `scope`, manifest icon URLs, and Vite `base` together.

---

## 8. HTML Metadata

Update `index.html`:

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My App</title>
  <meta name="description" content="A Progressive Web App built with Vite" />
  <meta name="theme-color" content="#0f172a" />

  <link rel="manifest" href="/manifest.json" />
  <link rel="icon" href="/favicon.ico" />
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
  <link rel="mask-icon" href="/icons/mask-icon.svg" color="#0f172a" />

  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="apple-mobile-web-app-title" content="My App" />
</head>
```

Keep `theme-color` in `index.html` and `manifest.json` consistent unless the app intentionally changes it at runtime.

---

## 9. Home Screen Installation

Use the `beforeinstallprompt` event for Chromium browsers and separate iOS instructions. Do not assume `beforeinstallprompt` exists everywhere.

```tsx
// src/InstallPrompt.tsx
import { useEffect, useState } from 'react'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isIOS, setIsIOS] = useState(false)
  const [isStandalone, setIsStandalone] = useState(false)

  useEffect(() => {
    const ua = window.navigator.userAgent
    setIsIOS(/iPad|iPhone|iPod/.test(ua) && !('MSStream' in window))
    setIsStandalone(window.matchMedia('(display-mode: standalone)').matches)

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setDeferredPrompt(event as BeforeInstallPromptEvent)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
  }, [])

  if (isStandalone) return null

  const install = async () => {
    if (!deferredPrompt) return

    await deferredPrompt.prompt()
    await deferredPrompt.userChoice
    setDeferredPrompt(null)
  }

  return (
    <div>
      {deferredPrompt ? <button onClick={install}>Install app</button> : null}
      {isIOS ? <p>Install from Safari using Share, then Add to Home Screen.</p> : null}
    </div>
  )
}
```

Production apps should show this prompt only in a relevant place, such as settings, onboarding, or a dismissible banner after the manifest and service worker are valid.

---

## 10. Push Notifications

Push notifications are not Vite-specific. They require:

- HTTPS, except `localhost`
- An active service worker
- User permission
- VAPID keys
- A backend endpoint to store subscriptions and send pushes

### Generate VAPID Keys

```bash
yarn global add web-push
web-push generate-vapid-keys
```

Store only the public key in client-exposed env:

```env
VITE_VAPID_PUBLIC_KEY=your_public_key_here
VAPID_PRIVATE_KEY=your_private_key_here
VAPID_EMAIL=mailto:you@example.com
```

Vite exposes only `VITE_*` variables to browser code. Never expose `VAPID_PRIVATE_KEY`.

### Client Subscription Helper

```ts
// src/push.ts
function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)

  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}

export async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' as const }
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return { ok: false, reason: 'permission-denied' as const }
  }

  const registration = await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  if (existing) return { ok: true, subscription: existing }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY),
  })

  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  })

  return { ok: true, subscription }
}

export async function unsubscribeFromPush() {
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()

  if (!subscription) return

  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  })

  await subscription.unsubscribe()
}
```

### Service Worker Push Handlers

Add before `serwist.addEventListeners()` in `src/sw.ts`:

```ts
self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return

  const data = event.data.json() as {
    title?: string
    body?: string
    icon?: string
    url?: string
  }

  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Notification', {
      body: data.body,
      icon: data.icon ?? '/icons/icon-192x192.png',
      badge: '/icons/badge-72x72.png',
      data: { url: data.url ?? '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()

  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      const targetUrl = new URL(event.notification.data?.url ?? '/', self.location.origin).href
      const existingClient = clientList.find((client) => client.url === targetUrl && 'focus' in client)

      return existingClient ? existingClient.focus() : self.clients.openWindow(targetUrl)
    }),
  )
})
```

### Backend Requirements

Vite does not provide server actions. Implement push endpoints in the app's actual backend, for example Express, Hono, Fastify, Rails, Laravel, Cloudflare Workers, Supabase Edge Functions, or another API service.

Install backend dependencies where the server runs:

```bash
yarn add web-push
yarn add -D @types/web-push
```

Example Node handler shape:

```ts
import webpush from 'web-push'

webpush.setVapidDetails(
  process.env.VAPID_EMAIL!,
  process.env.VITE_VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!,
)

export async function sendPush(subscription: webpush.PushSubscription, message: string) {
  await webpush.sendNotification(
    subscription,
    JSON.stringify({
      title: 'Notification',
      body: message,
      icon: '/icons/icon-192x192.png',
      url: '/',
    }),
  )
}
```

Persist subscriptions keyed by `endpoint`. Delete subscriptions when `sendNotification` returns 404 or 410.

---

## 11. Local Development and HTTPS

Service workers work on `localhost` over HTTP, but push and install behavior is closer to production when tested over HTTPS.

Options:

```bash
# Localhost smoke test
yarn vite --host 127.0.0.1

# HTTPS with a Vite TLS plugin or proxy, depending on the project
yarn add -D @vitejs/plugin-basic-ssl
```

```ts
// vite.config.ts
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [
    basicSsl(),
    // framework plugin,
    // serwist plugin,
  ],
})
```

When debugging stale caches:

1. Open DevTools Application tab.
2. Unregister old service workers.
3. Clear Cache Storage and IndexedDB if the app caches data there.
4. Hard reload.
5. Rebuild and retest `dist` with `vite preview`.

---

## 12. Production Verification Checklist

- [ ] `yarn build` emits `dist/sw.js`.
- [ ] `/sw.js` serves JavaScript with a 200 response.
- [ ] `/manifest.json` serves valid JSON with correct `start_url`, `scope`, icons, and colors.
- [ ] `index.html` links to `/manifest.json` and has `theme-color`.
- [ ] DevTools Application tab shows an active service worker.
- [ ] DevTools Application tab validates the manifest and icons.
- [ ] Offline reload shows the expected app shell or offline fallback.
- [ ] Updates install cleanly without trapping users on stale assets.
- [ ] Lighthouse PWA checks pass for the target browsers.
- [ ] iOS Safari and Chromium are tested separately; install and push behavior differ.
- [ ] Push subscriptions are stored server-side and removed on 404/410 send failures.

---

## 13. Common Failure Modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Cannot find module 'virtual:serwist'` | Missing Serwist typings or plugin not loaded | Add `@serwist/vite/typings` and ensure `serwist(...)` is in `vite.config.ts`. |
| Worker registers but controls only `/sw.js` | Worker emitted under a subpath or bad scope | Emit `swDest: 'sw.js'` and register from the app root. |
| Offline works in dev but not production | `globDirectory` or deployment base mismatch | Align `globDirectory`, Vite `base`, manifest URLs, and deployment path. |
| New builds do not appear | Old service worker/cache still active | Use `skipWaiting`, `clientsClaim`, and test update prompts; clear old dev workers. |
| Push subscribe fails | Missing HTTPS, blocked permission, bad VAPID key, or worker not ready | Verify permission, `navigator.serviceWorker.ready`, and public key conversion. |
| iOS push does nothing | App is not installed or iOS version unsupported | iOS push requires an installed web app and Safari support. |

---

## Minimal Setup

1. Install `@serwist/vite`, `@serwist/window`, and `serwist`.
2. Add `serwist(...)` to `vite.config.ts`.
3. Add Serwist types and worker libs to TypeScript config.
4. Create `src/sw.ts` with `defaultCache`.
5. Register the worker through `virtual:serwist`.
6. Create `public/manifest.json`.
7. Link the manifest and app icons in `index.html`.
8. Build and verify `dist/sw.js`, manifest validity, installability, and offline behavior.

<!-- version: 2.0.0 -->
