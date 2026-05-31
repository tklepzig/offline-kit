# @tklepzig/offline-kit

Offline-PWA toolkit for a small family of offline-first PWAs. It owns the three
things every offline PWA in the family was hand-rolling:

- a **hardened service worker** (resilient per-URL precache, navigation
  fallback, content-hashed cache versioning, foreign-cache-safe eviction),
- an **offline-readiness signal** the app renders into its own badge, and
- **build orchestration** — esbuild bundles your `sw.ts`/`ui.ts` and injects a
  content-hashed precache manifest, so the asset list can't drift from reality.

> Designed for the family's no-bundler stack: esbuild bundles the consumer's
> entry points (importing this package), `tsc` only type-checks.

## Service worker — `sw.ts`

```ts
/// <reference types="@tklepzig/offline-kit/global" />
import { createOfflineServiceWorker } from "@tklepzig/offline-kit/sw";

createOfflineServiceWorker({
  cacheName: "myapp-cache",
  precache: __SW_MANIFEST, // injected at build time by the CLI / buildPwa()
});
```

Type-check it with the shipped base config:

```jsonc
// tsconfig.sw.json
{ "extends": "@tklepzig/offline-kit/tsconfig-sw.json", "files": ["sw.ts"] }
```

## Page — `ui.ts`

```ts
import { observeOfflineReadiness } from "@tklepzig/offline-kit";

observeOfflineReadiness({
  onStatus: ({ state, missing }) => {
    // state: "caching" | "ready" | "incomplete" | "unavailable"
    // render your own badge / text here
  },
});
```

The returned handle has `refresh()` for an on-demand re-check (e.g. when a
dialog showing the badge opens).

## Build — the CLI (no build script needed)

Add an `offline-kit.config.js` and call the CLI from your build:

```js
// offline-kit.config.js
export default {
  precache: ["ui.js", "style.min.css", "manifest.webmanifest", "assets/**/*"],
};
```

```jsonc
// package.json
"scripts": {
  "build": "tsc --noEmit && tsc -p tsconfig.sw.json --noEmit && sass … && offline-kit build",
  "pwa:watch": "offline-kit build --watch"
}
```

Defaults: page `ui.ts → ui.js` (ESM), SW `sw.ts → sw.js` (IIFE), `target:
"es2020"`, shell `"./"` from `index.html`. `offline-kit build --watch` runs an
esbuild watch for the dev loop.

### Programmatic API

The CLI is a thin wrapper over `buildPwa`, which stays exported for apps that
need extra build steps or custom control:

```ts
import { buildPwa } from "@tklepzig/offline-kit/build";

await buildPwa({ precache: [...], watch: false });
```

## Releases

Versioned with [Changesets](https://github.com/changesets/changesets); snapshot
releases publish from a PR via a `/snapshot` comment (see `.github/workflows`).
