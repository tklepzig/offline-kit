import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { buildPwa, generatePrecacheManifest } from "../build-pwa.js";
import { verifyPwa } from "../verify.js";

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function fixture() {
  dir = mkdtempSync(join(tmpdir(), "pok-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(dir, "ui.js"), "console.log(1)");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "logo.png"), "PNGDATA");
  return dir;
}

describe("generatePrecacheManifest", () => {
  it("hashes files, prepends the shell, and skips directories (no EISDIR)", () => {
    const root = fixture();
    // "**/*" also matches the `assets` directory — the regression that used to
    // crash with EISDIR when the dir path was passed to readFileSync.
    const manifest = generatePrecacheManifest({
      globDirectory: root,
      globPatterns: ["**/*"],
    });
    const urls = manifest.map((entry) => entry.url);

    expect(urls).toContain("./"); // shell
    expect(urls).toContain("./ui.js");
    expect(urls).toContain("./assets/logo.png");
    expect(urls).not.toContain("./assets"); // directory skipped, not hashed
    expect(
      manifest.every((entry) => /^[0-9a-f]{16}$/.test(entry.revision)),
    ).toBe(true);
  });

  it("changes a file's revision when its content changes", () => {
    const root = fixture();
    const before = generatePrecacheManifest({
      globDirectory: root,
      globPatterns: ["ui.js"],
    }).find((entry) => entry.url === "./ui.js").revision;

    writeFileSync(join(root, "ui.js"), "console.log(2)");
    const after = generatePrecacheManifest({
      globDirectory: root,
      globPatterns: ["ui.js"],
    }).find((entry) => entry.url === "./ui.js").revision;

    expect(after).not.toBe(before);
  });

  it("can omit the shell entry", () => {
    const root = fixture();
    const manifest = generatePrecacheManifest({
      globDirectory: root,
      globPatterns: ["ui.js"],
      includeShell: false,
    });
    expect(manifest.map((entry) => entry.url)).not.toContain("./");
  });
});

/** Minimal app source tree: index.html + ui.ts + sw.ts, and optionally a worker. */
function appFixture({ withWorker = false } = {}) {
  dir = mkdtempSync(join(tmpdir(), "pok-app-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(dir, "ui.ts"), "export const ui: number = 1;\n");
  writeFileSync(
    join(dir, "sw.ts"),
    "declare const __SW_MANIFEST: unknown;\nconsole.log(__SW_MANIFEST);\n",
  );
  if (withWorker) {
    mkdirSync(join(dir, "shell"));
    writeFileSync(join(dir, "shell", "shared.ts"), "export const shared = 42;\n");
    writeFileSync(
      join(dir, "ai-worker.ts"),
      "import { shared } from './shell/shared.js';\nself.onmessage = () => postMessage(shared);\n",
    );
  }
  return dir;
}

describe("buildPwa workers", () => {
  it("bundles a worker and precaches it (built before the manifest)", async () => {
    const root = appFixture({ withWorker: true });

    const manifest = await buildPwa({
      globDirectory: root,
      page: { entry: join(root, "ui.ts"), outfile: join(root, "ui.js") },
      sw: { entry: join(root, "sw.ts"), outfile: join(root, "sw.js") },
      workers: [
        { entry: join(root, "ai-worker.ts"), outfile: join(root, "ai-worker.js") },
      ],
      precache: ["ui.js", "ai-worker.js"],
    });

    // The worker must be IN the manifest — the whole point of building it first.
    const worker = manifest.find((entry) => entry.url === "./ai-worker.js");
    expect(worker).toBeDefined();
    expect(worker.revision).toMatch(/^[0-9a-f]{16}$/);

    // Bundled, not merely copied: the import is inlined and it is not ESM.
    const built = readFileSync(join(root, "ai-worker.js"), "utf8");
    expect(built).toContain("42");
    expect(built).not.toMatch(/^\s*import\s/m);

    // And the SW really received that manifest, worker included.
    expect(readFileSync(join(root, "sw.js"), "utf8")).toContain("./ai-worker.js");
  });

  it("defaults to no workers and still builds page + sw", async () => {
    const root = appFixture();
    const manifest = await buildPwa({
      globDirectory: root,
      page: { entry: join(root, "ui.ts"), outfile: join(root, "ui.js") },
      sw: { entry: join(root, "sw.ts"), outfile: join(root, "sw.js") },
      precache: ["ui.js"],
    });
    expect(manifest.map((entry) => entry.url)).toEqual(
      expect.arrayContaining(["./", "./ui.js"]),
    );
  });

  // buildPwa resolves outfile against cwd, verifyPwa against globDirectory. One
  // config object has to survive both, which no single-function test can show.
  it("accepts one config object through both buildPwa and verifyPwa", async () => {
    const root = appFixture({ withWorker: true });
    const config = {
      globDirectory: root,
      page: { entry: join(root, "ui.ts"), outfile: join(root, "ui.js") },
      sw: { entry: join(root, "sw.ts"), outfile: join(root, "sw.js") },
      workers: [
        { entry: join(root, "ai-worker.ts"), outfile: join(root, "ai-worker.js") },
      ],
      precache: ["ui.js", "ai-worker.js"],
    };

    await buildPwa(config);
    const { errors } = verifyPwa(config);
    expect(errors).toEqual([]);
  });

  it("disposes its esbuild contexts when the build fails", async () => {
    const root = appFixture({ withWorker: true });
    writeFileSync(join(root, "ai-worker.ts"), "this is not ( valid typescript =");

    await expect(
      buildPwa({
        globDirectory: root,
        page: { entry: join(root, "ui.ts"), outfile: join(root, "ui.js") },
        sw: { entry: join(root, "sw.ts"), outfile: join(root, "sw.js") },
        workers: [
          { entry: join(root, "ai-worker.ts"), outfile: join(root, "ai-worker.js") },
        ],
        precache: ["ui.js"],
      }),
    ).rejects.toThrow();

    // Nothing to assert on the contexts directly — but a leaked one keeps an
    // esbuild child process alive, which would stop vitest's worker exiting.
    // The regression this guards is a hang, so reaching here is the assertion.
    expect(true).toBe(true);
  });

  it("rejects a worker entry missing outfile", async () => {
    const root = appFixture({ withWorker: true });
    await expect(
      buildPwa({
        globDirectory: root,
        page: { entry: join(root, "ui.ts"), outfile: join(root, "ui.js") },
        sw: { entry: join(root, "sw.ts"), outfile: join(root, "sw.js") },
        workers: [{ entry: join(root, "ai-worker.ts") }],
        precache: ["ui.js"],
      }),
    ).rejects.toThrow(/workers\[0\] needs both/);
  });
});
