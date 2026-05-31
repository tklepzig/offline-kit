// Ambient type for the build-time-injected precache manifest. buildPwa()'s
// esbuild `define` replaces the __SW_MANIFEST identifier with the generated
// array, so the consumer's sw.ts can reference it WITHOUT hand-writing a
// `declare const` (which would re-introduce the magic-string drift risk).
//
// Consume it from sw.ts with:
//   /// <reference types="@tklepzig/offline-kit/global" />
declare const __SW_MANIFEST: { url: string; revision: string }[];
