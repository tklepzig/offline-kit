---
"@tklepzig/offline-kit": patch
---

Self-heal a failed/partial precache. Previously the cache was only populated in
the `install` handler, which re-fires only when `sw.js` changes — so a cache
left empty by a transient failure at install (offline first launch, mid-deploy
404) stayed permanently "incomplete" and a page reload could not repair it. The
readiness query now re-attempts the missing entries and reports the post-repair
result, so a plain reload fixes the cache.
