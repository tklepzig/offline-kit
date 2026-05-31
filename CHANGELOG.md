# @tklepzig/offline-kit

## 0.1.0

### Minor Changes

- 00fba13: Initial release. Extracts the family's offline-PWA pattern into a shared toolkit:

  - `createOfflineServiceWorker` — resilient per-URL precache (`allSettled`, no
    whole-batch abort), navigation fallback to the cached shell, content-hashed
    cache versioning, and foreign-cache-safe eviction.
  - `observeOfflineReadiness` — registration (with failure surfacing), durable
    storage request, a MessageChannel readiness query, and a don't-downgrade
    status state machine the app renders into its own badge.
  - `buildPwa` / `generatePrecacheManifest` — esbuild orchestration that bundles
    the page + service-worker entries and injects a content-hashed precache
    manifest globbed from the built output.
