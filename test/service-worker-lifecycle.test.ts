import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOfflineServiceWorker, hashManifest } from "../src/service-worker.js";
import { OFFLINE_READY_MESSAGE } from "../src/shared.js";

// The SW side talks to the platform via three globals — `caches`, `self`, and
// `Request` — plus `ExtendableEvent.waitUntil`. jsdom provides none of them, so
// this is a minimal in-memory harness: just enough surface to drive the install
// / activate / message handlers and assert on what landed in the cache. Node's
// global `Request` is real (used verbatim by the SW); only `caches`/`self` are
// faked. Absolute URLs throughout so `new Request(url)` needs no base document.

type NetworkState = "ok" | "fail";

const CACHE_BASE = "test-cache";
const MANIFEST = [
  { url: "https://example.test/", revision: "shell" },
  { url: "https://example.test/ui.js", revision: "ui" },
  { url: "https://example.test/style.css", revision: "style" },
];
const URLS = MANIFEST.map((entry) => entry.url);
const CACHE_NAME = `${CACHE_BASE}-${hashManifest(MANIFEST)}`;

// A Cache whose `add` succeeds or rejects per a mutable network table, so a
// test can start "offline" and let connectivity recover mid-run. `gate` lets a
// test hold adds open to create a real in-flight window for the dedup check.
class FakeCache {
  readonly store = new Map<string, { url: string }>();
  readonly addCalls: string[] = [];

  constructor(
    private readonly network: Map<string, NetworkState>,
    private readonly gate: () => Promise<void>,
  ) {}

  async add(request: Request): Promise<void> {
    const { url } = request;
    this.addCalls.push(url);
    await this.gate();
    // Real cache.add rejects on a network error / non-2xx — model that as reject.
    if (this.network.get(url) === "fail") {
      throw new TypeError(`network failure for ${url}`);
    }
    this.store.set(url, { url });
  }

  async match(url: string): Promise<{ url: string } | undefined> {
    return this.store.get(url);
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  readonly deleted: string[] = [];
  gate: () => Promise<void> = () => Promise.resolve();

  constructor(private readonly network: Map<string, NetworkState>) {}

  async open(name: string): Promise<FakeCache> {
    const existing = this.caches.get(name);
    if (existing) return existing;
    const cache = new FakeCache(this.network, () => this.gate());
    this.caches.set(name, cache);
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    this.deleted.push(name);
    return this.caches.delete(name);
  }
}

class FakeServiceWorkerGlobalScope {
  readonly handlers = new Map<string, (event: unknown) => void>();
  skipWaitingCalled = false;
  claimCalled = false;
  readonly clients = {
    claim: async (): Promise<void> => {
      this.claimCalled = true;
    },
  };

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.handlers.set(type, handler);
  }

  async skipWaiting(): Promise<void> {
    this.skipWaitingCalled = true;
  }
}

type CapturingEvent = { waited: Promise<unknown>; waitUntil: (promise: Promise<unknown>) => void };

function makeLifecycleEvent(): CapturingEvent {
  const event = { waited: Promise.resolve() as Promise<unknown> } as CapturingEvent;
  event.waitUntil = (promise) => {
    event.waited = promise;
  };
  return event;
}

function makeMessagePort() {
  const posted: Array<{ ready: boolean; missing: string[] }> = [];
  return {
    posted,
    postMessage: (message: { ready: boolean; missing: string[] }) => posted.push(message),
  };
}

function makeMessageEvent(
  data: unknown,
  port: ReturnType<typeof makeMessagePort>,
): CapturingEvent & { data: unknown; ports: unknown[] } {
  const event = makeLifecycleEvent() as CapturingEvent & { data: unknown; ports: unknown[] };
  event.data = data;
  event.ports = [port];
  return event;
}

async function dispatch(
  scope: FakeServiceWorkerGlobalScope,
  type: string,
  event: CapturingEvent,
): Promise<void> {
  const handler = scope.handlers.get(type);
  if (!handler) throw new Error(`no handler registered for "${type}"`);
  handler(event);
  await event.waited;
}

const readinessMessage = { type: OFFLINE_READY_MESSAGE };

describe("createOfflineServiceWorker lifecycle", () => {
  let network: Map<string, NetworkState>;
  let storage: FakeCacheStorage;
  let scope: FakeServiceWorkerGlobalScope;

  const originalCaches = (globalThis as { caches?: unknown }).caches;
  const originalSelf = (globalThis as { self?: unknown }).self;

  beforeEach(() => {
    network = new Map(URLS.map((url) => [url, "ok"] as const));
    storage = new FakeCacheStorage(network);
    scope = new FakeServiceWorkerGlobalScope();
    (globalThis as { caches?: unknown }).caches = storage;
    (globalThis as { self?: unknown }).self = scope;
  });

  afterEach(() => {
    (globalThis as { caches?: unknown }).caches = originalCaches;
    (globalThis as { self?: unknown }).self = originalSelf;
  });

  it("precache adds every manifest url and skips waiting", async () => {
    createOfflineServiceWorker({ cacheName: CACHE_BASE, precache: MANIFEST });
    await dispatch(scope, "install", makeLifecycleEvent());

    const cache = await storage.open(CACHE_NAME);
    expect([...cache.store.keys()].sort()).toEqual([...URLS].sort());
    expect(scope.skipWaitingCalled).toBe(true);
  });

  it("one failing asset does not abort the rest (allSettled, not addAll)", async () => {
    const [shell, ui, style] = URLS;
    network.set(ui, "fail");

    createOfflineServiceWorker({ cacheName: CACHE_BASE, precache: MANIFEST });
    await dispatch(scope, "install", makeLifecycleEvent());

    const cache = await storage.open(CACHE_NAME);
    expect(cache.store.has(ui)).toBe(false);
    expect(cache.store.has(shell)).toBe(true);
    expect(cache.store.has(style)).toBe(true);
  });

  it("readiness query reports exactly the missing urls when offline", async () => {
    URLS.forEach((url) => network.set(url, "fail"));

    createOfflineServiceWorker({ cacheName: CACHE_BASE, precache: MANIFEST });
    await dispatch(scope, "install", makeLifecycleEvent()); // cache stays empty

    const port = makeMessagePort();
    await dispatch(scope, "message", makeMessageEvent(readinessMessage, port));

    expect(port.posted).toHaveLength(1);
    expect(port.posted[0].ready).toBe(false);
    expect([...port.posted[0].missing].sort()).toEqual([...URLS].sort());
  });

  it("readiness query repairs a cache emptied by a transient failure", async () => {
    URLS.forEach((url) => network.set(url, "fail"));

    createOfflineServiceWorker({ cacheName: CACHE_BASE, precache: MANIFEST });
    await dispatch(scope, "install", makeLifecycleEvent()); // empty: install failed

    URLS.forEach((url) => network.set(url, "ok")); // connectivity recovers

    const port = makeMessagePort();
    await dispatch(scope, "message", makeMessageEvent(readinessMessage, port));

    // The reload that triggered this query already comes back ready.
    expect(port.posted[0].ready).toBe(true);
    expect(port.posted[0].missing).toEqual([]);
    const cache = await storage.open(CACHE_NAME);
    expect([...cache.store.keys()].sort()).toEqual([...URLS].sort());
  });

  it("concurrent readiness queries share one repair (in-flight dedup)", async () => {
    URLS.forEach((url) => network.set(url, "fail"));

    createOfflineServiceWorker({ cacheName: CACHE_BASE, precache: MANIFEST });
    await dispatch(scope, "install", makeLifecycleEvent());

    const cache = await storage.open(CACHE_NAME);
    cache.addCalls.length = 0; // ignore the failed install attempts
    URLS.forEach((url) => network.set(url, "ok"));

    // Hold adds open so both queries reach repairMissing while a repair is live.
    // One shared gate (not a per-call factory) so a single release frees them all.
    let releaseAdds = (): void => {};
    const addGate = new Promise<void>((resolve) => (releaseAdds = resolve));
    storage.gate = () => addGate;

    const firstPort = makeMessagePort();
    const secondPort = makeMessagePort();
    const firstEvent = makeMessageEvent(readinessMessage, firstPort);
    const secondEvent = makeMessageEvent(readinessMessage, secondPort);
    scope.handlers.get("message")!(firstEvent);
    scope.handlers.get("message")!(secondEvent);

    await new Promise((resolve) => setTimeout(resolve, 0)); // drain up to the gate
    releaseAdds();
    await Promise.all([firstEvent.waited, secondEvent.waited]);

    const addCountByUrl = cache.addCalls.reduce((counts, url) => {
      counts.set(url, (counts.get(url) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
    URLS.forEach((url) => expect(addCountByUrl.get(url)).toBe(1));
    expect(firstPort.posted[0].ready).toBe(true);
    expect(secondPort.posted[0].ready).toBe(true);
  });

  it("activate evicts only this kit's stale caches, never foreign ones", async () => {
    createOfflineServiceWorker({ cacheName: CACHE_BASE, precache: MANIFEST });
    await dispatch(scope, "install", makeLifecycleEvent()); // creates CACHE_NAME

    await storage.open(`${CACHE_BASE}-stale0000`); // an older kit cache
    await storage.open("runtime-images"); // a foreign cache the app may keep

    await dispatch(scope, "activate", makeLifecycleEvent());

    expect(storage.deleted).toContain(`${CACHE_BASE}-stale0000`);
    expect(storage.deleted).not.toContain(CACHE_NAME);
    expect(storage.deleted).not.toContain("runtime-images");
    expect(scope.claimCalled).toBe(true);
  });
});
