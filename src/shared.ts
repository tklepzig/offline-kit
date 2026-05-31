// The contract both layers agree on. Defined once here and imported by the
// service-worker side AND the page side, so the message name and result shape
// can never drift between them — the whole reason this is a package.

export const OFFLINE_READY_MESSAGE = "CHECK_OFFLINE_READY";

// One precached asset and a content revision (hash). The build helper produces
// these by hashing the built files; any change to a file changes its revision.
export type PrecacheEntry = { url: string; revision: string };

// The SW's reply to a readiness query: ready when nothing is missing.
export type OfflineReadyResult = { ready: boolean; missing: string[] };

// The states the page side emits; the app maps these to its own UI/text.
export type OfflineStatusState =
  | "caching"
  | "ready"
  | "incomplete"
  | "unavailable";
