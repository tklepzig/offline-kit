/// <reference lib="webworker" />
// Service-worker side. The app's sw.ts imports createOfflineServiceWorker and
// passes its precache manifest (injected at build time); this wires the whole
// lifecycle. esbuild bundles this into the app's sw.js — the SW never imports
// anything at runtime.

import { OFFLINE_READY_MESSAGE } from "./shared.js";
import type { OfflineReadyResult, PrecacheEntry } from "./shared.js";

declare const self: ServiceWorkerGlobalScope;

export type ServiceWorkerConfig = {
  // Base cache name; the content revisions are hashed onto it so any changed
  // asset yields a fresh cache (and re-precache) with no manual build id.
  cacheName: string;
  precache: PrecacheEntry[];
  // What a navigation falls back to when the exact URL isn't cached. Defaults
  // to "./", whose entry holds the index document (see the family's PWA notes).
  navigationFallback?: string;
};

// Small, fast, dependency-free hash (FNV-1a, 32-bit) over the manifest so the
// cache name reflects content. Not cryptographic — only needs to change when
// any asset changes, which the per-file revisions already guarantee.
export function hashManifest(precache: PrecacheEntry[]): string {
  const input = precache
    .map((entry) => `${entry.url}@${entry.revision}`)
    .join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export function createOfflineServiceWorker(config: ServiceWorkerConfig): void {
  const navigationFallback = config.navigationFallback ?? "./";
  const urls = config.precache.map((entry) => entry.url);
  const cacheName = `${config.cacheName}-${hashManifest(config.precache)}`;

  // Per-URL add under allSettled, not cache.addAll: one failed asset must not
  // reject the whole batch and abort activation. We cache everything reachable,
  // activate regardless, and report the gap via the readiness check below.
  // `cache: "reload"` bypasses the HTTP cache so a fresh deploy can't precache a
  // stale copy of a non-content-hashed file (e.g. ui.js) that a CDN/browser
  // cache would otherwise serve — which would defeat the content-hashed cache.
  const cacheUrls = (targetUrls: string[]): Promise<unknown> =>
    caches
      .open(cacheName)
      .then((cache) =>
        Promise.allSettled(
          targetUrls.map((url) =>
            cache.add(new Request(url, { cache: "reload" })),
          ),
        ),
      );

  const precache = (): Promise<unknown> => cacheUrls(urls);

  // A failed/partial install-time precache is otherwise permanent: `install`
  // only re-fires when sw.js changes, so a cache left empty by a transient
  // failure (offline first launch, mid-deploy 404) never self-heals. When a
  // readiness query finds gaps, re-attempt just the missing entries so a plain
  // page reload repairs the cache. One attempt at a time — overlapping queries
  // share the in-flight run rather than stampeding the network.
  let repairInFlight: Promise<unknown> | null = null;
  const repairMissing = (missing: string[]): Promise<unknown> => {
    if (missing.length === 0) return Promise.resolve();
    if (!repairInFlight) {
      repairInFlight = cacheUrls(missing).finally(() => {
        repairInFlight = null;
      });
    }
    return repairInFlight;
  };

  self.addEventListener("install", (event) => {
    event.waitUntil(precache());
    void self.skipWaiting();
  });

  self.addEventListener("activate", (event) => {
    // Only evict THIS kit's own stale caches (same base name, different hash) —
    // never foreign caches a consuming app may keep (runtime/image caches etc.).
    const cachePrefix = `${config.cacheName}-`;
    event.waitUntil(
      caches
        .keys()
        .then((names) =>
          Promise.all(
            names
              .filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
              .map((name) => caches.delete(name)),
          ),
        )
        .then(() => self.clients.claim()),
    );
  });

  self.addEventListener("fetch", (event) => {
    const { request } = event;

    // Navigations fall back to the cached shell so the app boots offline even
    // when the exact launch URL (e.g. ./?source=pwa) doesn't byte-match a key.
    if (request.mode === "navigate") {
      event.respondWith(
        caches.match(request, { ignoreSearch: true }).then(
          (response) =>
            response ??
            fetch(request).catch(() =>
              caches
                .match(navigationFallback)
                .then((fallback) => fallback ?? Response.error()),
            ),
        ),
      );
      return;
    }

    // Cache-first for everything else.
    event.respondWith(
      caches.match(request).then((response) => response ?? fetch(request)),
    );
  });

  // Readiness check against the LIVE cache — honest across worker wake-ups and
  // even after eviction, because it inspects what's actually cached now.
  const checkOfflineReady = (): Promise<OfflineReadyResult> =>
    caches.open(cacheName).then((cache) =>
      Promise.all(
        urls.map((url) =>
          cache
            .match(url, { ignoreSearch: true })
            .then((match) => (match ? null : url)),
        ),
      ).then((results) => {
        const missing = results.filter(
          (url): url is string => url !== null,
        );
        return { ready: missing.length === 0, missing };
      }),
    );

  self.addEventListener("message", (event) => {
    if (!event.data || event.data.type !== OFFLINE_READY_MESSAGE) return;
    const port = event.ports[0];
    if (!port) return;
    event.waitUntil(
      checkOfflineReady().then((result) => {
        if (result.ready) {
          port.postMessage(result);
          return;
        }
        // Gap found: repair it, then report the post-repair truth so the reload
        // that triggered this query can already come back "ready". If repair
        // outlasts the page's query timeout, the page keeps its current state
        // and the next reload sees the now-full cache — either way it converges.
        return repairMissing(result.missing)
          .then(checkOfflineReady)
          .then((repaired) => port.postMessage(repaired));
      }),
    );
  });
}
