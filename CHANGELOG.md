# @tklepzig/offline-kit

## 0.3.0

### Minor Changes

- 8679388: Added a `workers` build option for bundling Web Workers.

  `buildPwa` (and the CLI via `offline-kit.config.js`) now accepts
  `workers: [{ entry, outfile, format? }]`. Worker bundles are built alongside the
  page entry — before the precache manifest is generated — so listing the outfile
  in `precache` actually caches it. Format defaults to `"iife"`, so a classic
  `new Worker("…")` needs no module support in the browser.

  `verifyPwa` reads the same `workers` config and treats each outfile as a
  referenced file. Without this a worker was invisible to the checker (it is only
  ever named inside JS, which the ref extractors don't parse), so an unprecached
  one would have shipped working online and broken offline with no error.

  Both options default to empty, so existing configs are unaffected.

  Also fixed along the way:

  - `buildPwa` now disposes its esbuild contexts when a build fails. Previously any
    error after context creation (a syntax error in a source file, a missing entry,
    an unreadable `shellFile`) left esbuild child processes running, hanging a
    programmatic caller's Node process. The CLI was unaffected — an unhandled
    rejection killed it outright.
  - `verifyPwa` now rebases an absolute `outfile` onto `globDirectory` instead of
    joining it blindly, so a config object really can be passed through both
    functions as its JSDoc claims. This previously produced a bogus "not found" for
    an absolute `sw.outfile`.
  - `verifyPwa` now reports an error for a malformed `workers` entry (or a
    non-array `workers`) rather than silently checking nothing.

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
