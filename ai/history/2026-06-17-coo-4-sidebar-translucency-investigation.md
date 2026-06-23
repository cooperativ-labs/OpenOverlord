# coo:4 — macOS sidebar translucency investigation

**Mission:** coo:4  
**Date:** 2026-06-17  
**Scope:** Investigation only (no implementation)

## Goal

Determine how to make `webapp/web/components/app-sidebar.tsx` translucent in the
macOS desktop app, aligned with native macOS sidebar appearance and Electron's
[custom window styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)
documentation.

## Current architecture

| Layer | Role today |
| --- | --- |
| `desktop/src/window.ts` | Creates `BrowserWindow` with `titleBarStyle: 'hiddenInset'`, `trafficLightPosition: { x: 14, y: 14 }`, opaque `backgroundColor: '#0b0b0f'` |
| `webapp/web/lib/desktop-chrome.ts` | Feature-detects shell via `window.overlord`; exposes `isMacDesktop` for drag regions |
| `webapp/web/components/ui/sidebar.tsx` | Sidebar inner panel uses opaque `bg-sidebar` (`data-slot="sidebar-inner"`) |
| `webapp/web/styles.css` | `--sidebar` tokens are fully opaque (`oklch(0.205 0 0)` dark, `oklch(0.985 0 0)` light) |
| `webapp/web/router.tsx` | `SidebarProvider` → `AppSidebar` (fixed left) + `SidebarInset` (main content + `NavHeader`) |

The sidebar is **fixed** at 16rem (`--sidebar-width`). Main content (`SidebarInset`)
and `body` use opaque `bg-background`. `NavHeader` currently reuses `bg-sidebar`.

Electron version: **42.4.0** (vibrancy regressions from Electron 30–31 were fixed
upstream in PR #42263).

## Approaches evaluated

### 1. Window-level `vibrancy: 'sidebar'` + transparent sidebar CSS (recommended)

Electron's `vibrancy` option maps to macOS `NSVisualEffectView` with the
`sidebar` material. It is applied **behind the entire web contents**, not to a
DOM region. Translucency appears wherever the renderer paints transparent pixels.

**Shell change** (`desktop/src/window.ts`, macOS only):

```ts
{
  titleBarStyle: 'hiddenInset',
  trafficLightPosition: { x: 14, y: 14 },
  vibrancy: 'sidebar',
  backgroundColor: '#00000000' // must be transparent for vibrancy to show
}
```

Alternatively call `window.setVibrancy('sidebar')` after creation.

**SPA change** (gated on `getDesktopChrome().isMacDesktop`):

- Make `[data-slot="sidebar-inner"]` background transparent (remove `bg-sidebar`
  or override with `bg-transparent`).
- Keep `SidebarInset`, `body`, and board content **opaque** (`bg-background`) so
  vibrancy only shows through the sidebar column.
- Optionally switch `NavHeader` from `bg-sidebar` to `bg-background` on macOS
  desktop so only the left rail is translucent (matches Finder / Mail pattern).
- Gate with a root `data-mac-desktop` attribute or a `desktop-chrome` utility
  class — browser builds stay unchanged.

**Pros:** No native addons; fits existing shell/SPA split; Electron 42 includes
vibrancy ordering fix; matches Tahoe-era native sidebar look.

**Cons:**

- Vibrancy is window-wide — correctness depends on keeping non-sidebar areas opaque.
- `transparent: true` is **not** required if only using vibrancy (unlike fully
  transparent windows). Setting `backgroundColor` to `#00000000` is enough.
- Light/dark vibrancy follows system appearance; app theme toggle may diverge
  slightly from native material until tested.
- Collapsed icon mode and `InitialSetupScreen` need the same opaque/transparent
  rules (setup screen should remain fully opaque).

### 2. CSS-only `backdrop-filter` (not recommended alone)

Adding `backdrop-filter: blur()` and semi-transparent `bg-sidebar/80` on the
sidebar without shell changes only blurs content **behind the element inside the
web view**. With an opaque window background (`#0b0b0f`), there is nothing
meaningful to blur — this does **not** reproduce macOS wallpaper tinting.

Useful only as a subtle complement on top of approach 1, not as a standalone fix.

### 3. Fully transparent `BrowserWindow` (`transparent: true`)

Per Electron docs, sets the entire window transparent. Combined with
region-specific CSS transparency, this can work but adds limitations:

- Native window shadow is hidden on macOS transparent windows.
- Harder to avoid visual artifacts during animations (`invalidateShadow()`).
- Higher risk of click-through and repaint glitches.

Prefer vibrancy without `transparent: true` unless a specific design requires it.

### 4. Native `NSVisualEffectView` per region (advanced)

Packages like [electron-tinted-with-sidebar](https://github.com/davidcann/electron-tinted-with-sidebar)
insert native visual-effect views for the sidebar column and titlebar via
`getNativeWindowHandle()`, with wallpaper tinting support.

**Pros:** Closest to native multi-region layout (sidebar + titlebar + inspector).

**Cons:** Native Node addon to build/sign/notarize; must sync sidebar width
(16rem ≈ 256px) and titlebar height with SPA layout; conflicts with contract
goal of a thin, audited shell.

Defer unless approach 1 is visually insufficient.

## Recommended implementation plan

### Phase A — Shell (desktop)

1. Add `vibrancy: 'sidebar'` and `backgroundColor: '#00000000'` to macOS
   `BrowserWindow` options in `createWindow()`.
2. Manually verify on macOS: traffic lights, drag regions, context menu, and
   window resize still behave correctly.
3. Update `desktop/docs/desktop-app.md` §2 (window baseline) with vibrancy note.

### Phase B — SPA (webapp, feature-detected)

1. Add `data-mac-desktop` on `<html>` via a tiny `DesktopChromeEffect` mounted in
   `RootLayout` (or `theme-provider.tsx`) when `isMacDesktop`.
2. In `styles.css` or Tailwind `@custom-variant`:

   ```css
   [data-mac-desktop] [data-slot='sidebar-inner'] {
     background: transparent;
   }
   ```

3. In `app-sidebar.tsx`, pass `className` to `Sidebar` for any mac-specific
   overrides if needed (border treatment).
4. Review `NavHeader` background on mac desktop (likely `bg-background`).
5. Confirm `InitialSetupScreen` and modals remain opaque.

### Phase C — Polish

- Tune sidebar border (`border-sidebar-border` may need reduced opacity).
- Test collapsed icon mode, light/dark/system theme, and `SidebarRail` hover.
- Test packaged/notarized build (vibrancy sometimes differs in dev vs signed app).

## Files touched in a future implementation

| File | Change |
| --- | --- |
| `desktop/src/window.ts` | `vibrancy`, transparent `backgroundColor` (macOS) |
| `desktop/docs/desktop-app.md` | Document vibrancy baseline |
| `webapp/web/styles.css` or new `desktop-chrome.css` | `[data-mac-desktop]` sidebar transparency |
| `webapp/web/components/app-sidebar.tsx` | Optional className / variant |
| `webapp/web/router.tsx` or `theme-provider.tsx` | Set `data-mac-desktop` on `<html>` |
| `webapp/web/components/nav-header.tsx` | Optional mac desktop background |

No `CONTRACT.md` change required unless a new `window.overlord` bridge member is
added (not needed for CSS-gated approach).

## Risks

| Risk | Mitigation |
| --- | --- |
| Vibrancy bleeds into main content | Keep `bg-background` on `SidebarInset`, `body`, board |
| Theme mismatch (app dark vs system light) | Test both; vibrancy follows macOS appearance |
| Electron vibrancy bugs on future upgrades | Pin Electron; re-test on major bumps |
| Performance / repaint on resize | Monitor; call `invalidateShadow()` only if artifacts appear |

## References

- [Electron — Custom Window Styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)
- [Electron — BrowserWindow `vibrancy` / `setVibrancy`](https://www.electronjs.org/docs/latest/api/browser-window)
- [Translucent sidebars in Electron apps](https://buttondown.com/steveharrison/archive/translucent-sidebars-in-electron-apps/)
- [electron/electron#42263](https://github.com/electron/electron/pull/42263) — vibrancy + Views API fix
- [electron-tinted-with-sidebar](https://github.com/davidcann/electron-tinted-with-sidebar) — native multi-region option
