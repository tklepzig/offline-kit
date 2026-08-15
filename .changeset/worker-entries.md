---
"@tklepzig/offline-kit": minor
---

Add a `workers` build option for bundling Web Workers.

`buildPwa` (and the CLI via `offline-kit.config.js`) now accepts
`workers: [{ entry, outfile, format? }]`. Worker bundles are built alongside the
page entry — before the precache manifest is generated — so listing the outfile
in `precache` actually caches it. Format defaults to `"iife"`, so a classic
`new Worker("…")` needs no module support in the browser.

`verifyPwa` reads the same `workers` config and treats each outfile as a
referenced file. Without this a worker is invisible to the checker (it is only
ever named inside JS, which the ref extractors don't parse), so an unprecached
one would ship working online and broken offline with no error.

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
- `verifyPwa` reports an error for a malformed `workers` entry (or a non-array
  `workers`) rather than silently checking nothing.
