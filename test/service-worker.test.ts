import { describe, expect, it } from "vitest";

import { hashManifest } from "../src/service-worker.js";

describe("hashManifest", () => {
  it("is deterministic for the same manifest", () => {
    const manifest = [
      { url: "./", revision: "aaa" },
      { url: "./ui.js", revision: "bbb" },
    ];
    expect(hashManifest(manifest)).toBe(hashManifest(manifest));
  });

  it("changes when any revision changes", () => {
    const before = hashManifest([{ url: "./ui.js", revision: "bbb" }]);
    const after = hashManifest([{ url: "./ui.js", revision: "ccc" }]);
    expect(after).not.toBe(before);
  });

  it("changes when a url changes", () => {
    const before = hashManifest([{ url: "./ui.js", revision: "bbb" }]);
    const after = hashManifest([{ url: "./app.js", revision: "bbb" }]);
    expect(after).not.toBe(before);
  });

  it("returns a short hex string", () => {
    expect(hashManifest([{ url: "./", revision: "x" }])).toMatch(/^[0-9a-f]+$/);
  });
});
