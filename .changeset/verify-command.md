---
"@tklepzig/offline-kit": minor
---

Add `offline-kit verify` (and the exported `verifyPwa()`): a static
offline-completeness check for the built output. It recomputes the precache
manifest from the config and fails when the built `sw.js` is stale or missing
entries, when the shell HTML / precached CSS / web app manifest reference a
file that doesn't exist, or when a referenced file isn't covered by the
precache globs. Intended as a CI step next to a runtime offline smoke test.
