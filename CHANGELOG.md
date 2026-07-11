# @tklepzig/offline-kit

## 0.2.0

### Minor Changes

- 86f5859: Add `offline-kit verify` (and the exported `verifyPwa()`): a static
  offline-completeness check for the built output. It recomputes the precache
  manifest from the config and fails when the built `sw.js` is stale or missing
  entries, when the shell HTML / precached CSS / web app manifest reference a
  file that doesn't exist, or when a referenced file isn't covered by the
  precache globs. Intended as a CI step next to a runtime offline smoke test.

## 0.1.2

### Patch Changes

- 858bef0: Self-heal a failed/partial precache. Previously the cache was only populated in
  the `install` handler, which re-fires only when `sw.js` changes — so a cache
  left empty by a transient failure at install (offline first launch, mid-deploy 404) stayed permanently "incomplete" and a page reload could not repair it. The
  readiness query now re-attempts the missing entries and reports the post-repair
  result, so a plain reload fixes the cache.

## 0.1.1

### Patch Changes

- ed1cbc3: Dummy Patch to test release workflow

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
