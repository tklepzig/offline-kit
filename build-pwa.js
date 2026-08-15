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
// bundle the page entry (and any worker bundles), generate the precache manifest
// from the built output, then bundle the service worker with the manifest
// injected. The esbuild formats (esm page / iife SW), the __SW_MANIFEST define,
// and the ordering are fixed here — the app only declares what to precache.
//
// The ordering is the load-bearing part: anything that must appear in the
// manifest has to be written to disk before step 2 runs.
//
// @param {object} options
// @param {string[] | { globDirectory?, globPatterns, includeShell?, shellFile? }} options.precache
//   What to precache. An array is shorthand for { globPatterns: [...] }.
// @param {{ entry?: string, outfile?: string }} [options.page]  default ui.ts -> ui.js
// @param {{ entry?: string, outfile?: string }} [options.sw]    default sw.ts -> sw.js
// @param {{ entry: string, outfile: string, format?: "iife" | "esm" }[]} [options.workers]
//   Extra bundles that ship as their own file — Web Workers, typically. Built
//   alongside the page, i.e. *before* the manifest is generated, so listing the
//   outfile in `precache` actually caches it (a worker fetched at runtime is not
//   covered by the page bundle, so without this it would break offline). Bundled
//   as "iife" by default: a classic worker needs no module support in the
//   browser, matching how the service worker is built. Default [].
// @param {string} [options.globDirectory]  default "." (where built assets land)
// @param {string} [options.target]         default "es2020"
// @param {boolean} [options.watch]  keep esbuild watching every entry (dev). The
//   precache manifest is snapshotted at startup in watch mode — fine for dev,
//   where offline correctness isn't the focus.
// @returns {Promise<{ url: string, revision: string }[]>} the generated manifest
export async function buildPwa(options) {
  const {
    page = {},
    sw = {},
    workers = [],
    precache,
    globDirectory = ".",
    target = "es2020",
    watch = false,
  } = options;

  // Validate before creating any esbuild context, so a bad config can't leak
  // an already-created one (contexts hold a child process until disposed).
  workers.forEach((worker, index) => {
    if (!worker?.entry || !worker?.outfile) {
      throw new TypeError(
        `buildPwa: workers[${index}] needs both \`entry\` and \`outfile\``,
      );
    }
  });

  const shared = { bundle: true, target, legalComments: "none" };
  // esbuild keeps a child process alive per context until it is disposed, so
  // anything that throws partway through — a syntax error in a source file, a
  // missing entry, a shellFile the manifest can't read — would otherwise hang a
  // programmatic caller's Node process. (The CLI gets away with it only because
  // an unhandled rejection kills the process outright.) Track every context as
  // it is created and clean up in `finally`.
  const created = [];
  const track = async (buildOptions) => {
    const ctx = await esbuildContext(buildOptions);
    created.push(ctx);
    return ctx;
  };

  let watching = false;
  try {
    const pageCtx = await track({
      ...shared,
      entryPoints: [page.entry ?? "ui.ts"],
      format: "esm",
      outfile: page.outfile ?? "ui.js",
    });
    // Created in sequence on purpose: with Promise.all, one rejected creation
    // strands the contexts that already resolved — unreachable, so never
    // disposable. Creation is cheap; the parallelism that matters is in rebuild.
    const workerCtxs = [];
    for (const worker of workers) {
      workerCtxs.push(
        await track({
          ...shared,
          entryPoints: [worker.entry],
          format: worker.format ?? "iife",
          outfile: worker.outfile,
        }),
      );
    }

    // 1. Page entry → ESM (loaded via <script type="module">), plus any worker
    //    bundles. Both land before step 2 so the manifest can see them.
    await Promise.all([
      pageCtx.rebuild(),
      ...workerCtxs.map((ctx) => ctx.rebuild()),
    ]);

    // 2. Manifest from the freshly built output.
    const manifestOptions = Array.isArray(precache)
      ? { globDirectory, globPatterns: precache }
      : { globDirectory, ...precache };
    const manifest = generatePrecacheManifest(manifestOptions);

    // 3. Service worker → classic (IIFE), with the manifest inlined.
    const swCtx = await track({
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
      await Promise.all(workerCtxs.map((ctx) => ctx.watch()));
      // Contexts stay alive (and the process with them) until killed.
      watching = true;
    }

    return manifest;
  } finally {
    // Watch mode deliberately keeps them running — but only once watching is
    // actually established; a failure before that still has to clean up.
    if (!watching) await Promise.all(created.map((ctx) => ctx.dispose()));
  }
}
