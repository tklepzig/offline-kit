// Page side. The app's ui.ts calls observeOfflineReadiness and renders the
// emitted state however it likes (text, badge, language — all the app's call).
// This owns the lifecycle: persistent storage, SW registration with a catch,
// controllerchange re-checks, the MessageChannel query, and the state machine
// that avoids downgrading a known-good verdict.

import { OFFLINE_READY_MESSAGE } from "./shared.js";
import type { OfflineReadyResult, OfflineStatusState } from "./shared.js";

export type OfflineStatus = { state: OfflineStatusState; missing: string[] };

export type ObserveOptions = {
  swUrl?: string;
  timeoutMs?: number;
  onStatus: (status: OfflineStatus) => void;
};

export type OfflineReadinessHandle = {
  // Re-query readiness on demand (e.g. when an app opens a dialog that shows the
  // badge, to catch a cache evicted since the last check).
  refresh: () => void;
};

// Ask the active SW over a one-shot MessageChannel. Resolves null if there's no
// worker yet or it doesn't answer in time — the caller leaves the state as-is.
function askServiceWorker(
  worker: ServiceWorker,
  timeoutMs: number,
): Promise<OfflineReadyResult | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    // Close the port in both paths so repeated refresh() calls (dialog opens,
    // controllerchange) don't leak MessagePorts over a long-lived session.
    const settle = (value: OfflineReadyResult | null) => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(value);
    };
    const timeout = setTimeout(() => settle(null), timeoutMs);
    channel.port1.onmessage = (event) => settle(event.data as OfflineReadyResult);
    worker.postMessage({ type: OFFLINE_READY_MESSAGE }, [channel.port2]);
  });
}

export function observeOfflineReadiness(
  options: ObserveOptions,
): OfflineReadinessHandle {
  const swUrl = options.swUrl ?? "sw.js";
  const timeoutMs = options.timeoutMs ?? 3000;
  const { onStatus } = options;

  // No SW support (or insecure context): nothing meaningful to observe. Stay
  // silent so the app keeps its default (hidden) state rather than show noise.
  if (!("serviceWorker" in navigator)) {
    return { refresh: () => {} };
  }

  let registrationFailed = false;
  // Whether we've ever reached a real verdict (ready/incomplete). Used so a
  // re-check that times out can't downgrade a good badge back to "caching".
  let hasVerdict = false;

  const emit = (state: OfflineStatusState, missing: string[] = []): void => {
    if (state === "ready" || state === "incomplete") hasVerdict = true;
    onStatus({ state, missing });
  };

  const refresh = async (): Promise<void> => {
    if (registrationFailed) {
      emit("unavailable");
      return;
    }
    if (!hasVerdict) emit("caching");
    const registration = await navigator.serviceWorker.ready;
    const worker = navigator.serviceWorker.controller ?? registration.active;
    if (!worker) return;
    const result = await askServiceWorker(worker, timeoutMs);
    if (!result) return;
    emit(result.ready ? "ready" : "incomplete", result.missing);
  };

  // Durable storage to resist eviction (best-effort; ignored if denied).
  if (navigator.storage?.persist) void navigator.storage.persist();

  // Register, surfacing a failure instead of awaiting a worker that will never
  // arrive (navigator.serviceWorker.ready would hang forever otherwise).
  const register = (): void => {
    navigator.serviceWorker.register(swUrl).catch(() => {
      registrationFailed = true;
      void refresh();
    });
  };

  // Guard the load timing: if observeOfflineReadiness is called AFTER `load` has
  // already fired (late/async init), the listener would never run and the SW
  // would never register. Register immediately in that case.
  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    void refresh();
  });

  void refresh();

  return { refresh };
}
