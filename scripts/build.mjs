// Package build → dist/. JS is transpiled per-module by esbuild (kept as
// separate ESM files, not bundled, so consumers' bundlers tree-shake). Types
// are emitted in TWO tsc passes because the service worker needs the WebWorker
// lib and the page side needs the DOM lib — they can't share one lib set.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: [
    "src/shared.ts",
    "src/offline-readiness.ts",
    "src/service-worker.ts",
  ],
  outdir: "dist",
  format: "esm",
  target: "es2020",
  bundle: false,
  legalComments: "none",
});

// Declarations: DOM-lib pass (page + shared) then WebWorker-lib pass (SW).
execFileSync("npx", ["tsc", "-p", "tsconfig.dom.json"], { stdio: "inherit" });
execFileSync("npx", ["tsc", "-p", "tsconfig.webworker.json"], { stdio: "inherit" });

copyFileSync("global.d.ts", "dist/global.d.ts");

console.log("built dist/");
