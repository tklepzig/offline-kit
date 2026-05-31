// Build-time helper (Node). Globs the built output and hashes each file into a
// precache manifest [{ url, revision }], so the asset list can't drift from
// reality and revisions are content-based.
//
// Plain JS on purpose: it's imported by the app's Node build script via a normal
// `import`, with no .ts type-stripping flag needed.

import { createHash } from "node:crypto";
import { globSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { context as esbuildContext } from "esbuild";

function revisionOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * @param {object} options
 * @param {string} options.globDirectory   Root of the built output to scan.
 * @param {string[]} options.globPatterns  Globs (relative to globDirectory) of files to precache.
 * @param {boolean} [options.includeShell] Add a "./" entry for the app shell (default true).
 * @param {string} [options.shellFile]     File whose bytes back the "./" entry (default "index.html").
 * @returns {{ url: string, revision: string }[]}
 */
export function generatePrecacheManifest(options) {
  const {
    globDirectory,
    globPatterns,
    includeShell = true,
    shellFile = "index.html",
  } = options;

  const matched = new Set();
  for (const pattern of globPatterns) {
    for (const file of globSync(pattern, { cwd: globDirectory })) {
      const relative = file.split("\\").join("/");
      // globSync also returns directory entries (e.g. "assets" for "**/*");
      // hashing a directory would throw EISDIR. Keep regular files only.
      if (statSync(join(globDirectory, relative)).isFile()) matched.add(relative);
    }
  }

  const entries = [...matched].sort().map((relative) => ({
    url: `./${relative}`,
    revision: revisionOf(readFileSync(join(globDirectory, relative))),
  }));

  if (includeShell) {
    entries.unshift({
      url: "./",
      revision: revisionOf(readFileSync(join(globDirectory, shellFile))),
    });
  }

  return entries;
}

// Orchestrates the whole browser build so each app's build script is ~3 lines:
// bundle the page entry, generate the precache manifest from the built output,
// then bundle the service worker with the manifest injected. The esbuild
// formats (esm page / iife SW), the __SW_MANIFEST define, and the ordering are
// fixed here — the app only declares what to precache.
//
// @param {object} options
// @param {string[] | { globDirectory?, globPatterns, includeShell?, shellFile? }} options.precache
//   What to precache. An array is shorthand for { globPatterns: [...] }.
// @param {{ entry?: string, outfile?: string }} [options.page]  default ui.ts -> ui.js
// @param {{ entry?: string, outfile?: string }} [options.sw]    default sw.ts -> sw.js
// @param {string} [options.globDirectory]  default "." (where built assets land)
// @param {string} [options.target]         default "es2020"
// @param {boolean} [options.watch]  keep esbuild watching both entries (dev). The
//   precache manifest is snapshotted at startup in watch mode — fine for dev,
//   where offline correctness isn't the focus.
// @returns {Promise<{ url: string, revision: string }[]>} the generated manifest
export async function buildPwa(options) {
  const {
    page = {},
    sw = {},
    precache,
    globDirectory = ".",
    target = "es2020",
    watch = false,
  } = options;

  const shared = { bundle: true, target, legalComments: "none" };
  const pageCtx = await esbuildContext({
    ...shared,
    entryPoints: [page.entry ?? "ui.ts"],
    format: "esm",
    outfile: page.outfile ?? "ui.js",
  });

  // 1. Page entry → ESM (loaded via <script type="module">).
  await pageCtx.rebuild();

  // 2. Manifest from the freshly built output.
  const manifestOptions = Array.isArray(precache)
    ? { globDirectory, globPatterns: precache }
    : { globDirectory, ...precache };
  const manifest = generatePrecacheManifest(manifestOptions);

  // 3. Service worker → classic (IIFE), with the manifest inlined.
  const swCtx = await esbuildContext({
    ...shared,
    entryPoints: [sw.entry ?? "sw.ts"],
    format: "iife",
    outfile: sw.outfile ?? "sw.js",
    define: { __SW_MANIFEST: JSON.stringify(manifest) },
  });
  await swCtx.rebuild();

  if (watch) {
    await pageCtx.watch();
    await swCtx.watch();
    // Contexts stay alive (and the process with them) until killed.
  } else {
    await pageCtx.dispose();
    await swCtx.dispose();
  }

  return manifest;
}
