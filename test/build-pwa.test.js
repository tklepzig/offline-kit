import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generatePrecacheManifest } from "../build-pwa.js";

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
