// Static offline-completeness check (Node, plain JS like build-pwa.js).
//
// The build already globs the output into a content-hashed manifest, so the
// precache list can't drift from the files it matched. What CAN still go wrong:
//   1. the app references a file its globs don't cover (referenced ≠ precached),
//   2. a referenced file doesn't exist at all (broken link ships silently),
//   3. sw.js is stale — built before the latest asset change, so it precaches
//      old revisions (or misses new files entirely).
// verifyPwa() catches all three by sweeping the shell HTML, every precached CSS
// file, and the web app manifest for local references, and by requiring the
// built sw.js to embed the freshly recomputed manifest verbatim.
//
// Out of scope: URLs constructed in JS at runtime — that's what a runtime smoke
// test (boot the app, kill the server, reload) is for.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";

import { generatePrecacheManifest } from "./build-pwa.js";

// Anything with a scheme (https:, data:, mailto:, …) or protocol-relative.
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function cleanRef(raw) {
  const ref = raw.trim().replace(/[?#].*$/, "");
  if (ref === "" || EXTERNAL.test(ref) || ref.startsWith("/")) return null;
  return ref;
}

/** All local src/href values in an HTML string. */
export function extractHtmlRefs(html) {
  const refs = [];
  const attribute = /(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of html.matchAll(attribute)) {
    const ref = cleanRef(match[1] ?? match[2] ?? "");
    if (ref) refs.push(ref);
  }
  return refs;
}

/** All local url(...) values in a CSS string. */
export function extractCssRefs(css) {
  const refs = [];
  const urlCall = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/gi;
  for (const match of css.matchAll(urlCall)) {
    const ref = cleanRef(match[1] ?? match[2] ?? match[3] ?? "");
    if (ref) refs.push(ref);
  }
  return refs;
}

/** All local icon srcs in a web app manifest JSON string. */
export function extractWebmanifestRefs(json) {
  try {
    const manifest = JSON.parse(json);
    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    return icons
      .map((icon) => (typeof icon.src === "string" ? cleanRef(icon.src) : null))
      .filter((ref) => ref !== null);
  } catch {
    return [];
  }
}

/** Resolve a reference found in `fromFile` (root-relative) to a "./x" url.
 *  Both sides are separator-normalized: refs from `cleanRef` are already
 *  forward-slashed, but a `workers` outfile comes straight from the config and
 *  on Windows may carry backslashes, which would never match a manifest url. */
function toManifestUrl(ref, fromFile) {
  const base = posix.dirname(fromFile.split("\\").join("/"));
  const normalizedRef = ref.split("\\").join("/");
  return `./${posix.normalize(posix.join(base === "." ? "" : base, normalizedRef))}`;
}

/**
 * Verify the built output is fully offline-ready. Accepts the same options as
 * buildPwa() (an offline-kit.config.js can be passed straight through).
 *
 * @returns {{ errors: string[], manifest: { url: string, revision: string }[], checkedRefs: number }}
 */
/** An esbuild `outfile` as a path relative to `globDirectory`. buildPwa hands
 *  outfile to esbuild, which resolves it against cwd, while everything here is
 *  relative to globDirectory. They coincide in the CLI (both "."), but a
 *  programmatic caller may pass an absolute path — and verifyPwa documents that
 *  it takes the same options object, so rebase rather than reject. */
function outfileRelativeTo(globDirectory, outfile) {
  return isAbsolute(outfile) ? relative(resolve(globDirectory), outfile) : outfile;
}

export function verifyPwa(options) {
  const { precache, globDirectory = ".", sw = {}, workers = [] } = options;

  const manifestOptions = Array.isArray(precache)
    ? { globDirectory, globPatterns: precache }
    : { globDirectory, ...precache };
  const manifest = generatePrecacheManifest(manifestOptions);
  const manifestUrls = new Set(manifest.map((entry) => entry.url));

  const errors = [];

  // --- 1. sw.js exists and embeds the freshly recomputed manifest -----------
  const swFile = outfileRelativeTo(globDirectory, sw.outfile ?? "sw.js");
  const swPath = join(globDirectory, swFile);
  if (!existsSync(swPath)) {
    errors.push(`${swFile} not found — run the build first`);
  } else {
    const swText = readFileSync(swPath, "utf8");
    for (const entry of manifest) {
      // The manifest is inlined into sw.js as JSON, so url and revision appear
      // as double-quoted strings. A missing url = asset not precached; a
      // missing revision = sw.js was built before the file's latest change.
      if (!swText.includes(JSON.stringify(entry.url))) {
        errors.push(`${swFile} does not precache ${entry.url} — rebuild (stale sw.js)`);
      } else if (!swText.includes(JSON.stringify(entry.revision))) {
        errors.push(
          `${swFile} has an outdated revision for ${entry.url} — rebuild (stale sw.js)`,
        );
      }
    }
  }

  // --- 2. everything referenced exists and is precached ---------------------
  const shellFile = manifestOptions.shellFile ?? "index.html";
  const referenced = [];

  const shellPath = join(globDirectory, shellFile);
  if (!existsSync(shellPath)) {
    errors.push(`${shellFile} not found`);
  } else {
    for (const ref of extractHtmlRefs(readFileSync(shellPath, "utf8"))) {
      referenced.push({ url: toManifestUrl(ref, shellFile), from: shellFile });
    }
  }

  // A worker is loaded from JS (`new Worker("ai-worker.js")`), and refs are only
  // extracted from HTML/CSS/webmanifest — so nothing above can see it. Without
  // this, forgetting to precache a worker ships an app that works online and
  // breaks offline, with no error anywhere. The build already knows the
  // outfiles, so treat each as referenced.
  if (!Array.isArray(workers)) {
    errors.push("`workers` must be an array of { entry, outfile }");
  } else {
    workers.forEach((worker, index) => {
      // buildPwa throws on this; staying quiet here would report OK for a
      // config that cannot build — the opposite of the point of this check.
      if (!worker?.outfile) {
        errors.push(`workers[${index}] has no \`outfile\``);
        return;
      }
      const outfile = outfileRelativeTo(globDirectory, worker.outfile);
      referenced.push({ url: toManifestUrl(outfile, "."), from: "workers config" });
    });
  }

  for (const entry of manifest) {
    if (entry.url === "./") continue;
    const relative = entry.url.slice(2);
    if (relative.endsWith(".css")) {
      for (const ref of extractCssRefs(readFileSync(join(globDirectory, relative), "utf8"))) {
        referenced.push({ url: toManifestUrl(ref, relative), from: relative });
      }
    } else if (relative.endsWith(".webmanifest")) {
      for (const ref of extractWebmanifestRefs(
        readFileSync(join(globDirectory, relative), "utf8"),
      )) {
        referenced.push({ url: toManifestUrl(ref, relative), from: relative });
      }
    }
  }

  for (const { url, from } of referenced) {
    // The SW script itself is fetched by the browser's SW machinery (and
    // updated by it), not served from its own precache.
    if (url === `./${swFile}`) continue;
    if (!existsSync(join(globDirectory, url.slice(2)))) {
      errors.push(`${from} references ${url}, which does not exist`);
    } else if (!manifestUrls.has(url)) {
      errors.push(`${from} references ${url}, which is not precached — add it to the config`);
    }
  }

  return { errors, manifest, checkedRefs: referenced.length };
}
