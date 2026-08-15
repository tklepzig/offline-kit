import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generatePrecacheManifest } from "../build-pwa.js";
import {
  extractCssRefs,
  extractHtmlRefs,
  extractWebmanifestRefs,
  verifyPwa,
} from "../verify.js";

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const GLOBS = ["ui.js", "style.css", "manifest.webmanifest", "assets/**/*"];

/** A complete, consistent built app; tests then break one thing at a time. */
function fixture() {
  dir = mkdtempSync(join(tmpdir(), "pok-verify-"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><link href="style.css" rel="stylesheet" />
     <link rel="manifest" href="manifest.webmanifest" />
     <link rel="icon" href='assets/icon.svg' />
     <a href="https://example.com/external">x</a>
     <script type="module" src="ui.js"></script>`,
  );
  writeFileSync(join(dir, "ui.js"), "console.log(1)");
  writeFileSync(
    join(dir, "style.css"),
    `@font-face { src: url("./assets/font.woff2") format("woff2"); }
     .bg { background: url(assets/icon.svg); }
     .data { background: url(data:image/png;base64,AAAA); }`,
  );
  writeFileSync(
    join(dir, "manifest.webmanifest"),
    JSON.stringify({ icons: [{ src: "assets/icon-192.png" }] }),
  );
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "font.woff2"), "FONT");
  writeFileSync(join(dir, "assets", "icon.svg"), "<svg/>");
  writeFileSync(join(dir, "assets", "icon-192.png"), "PNG");
  writeSw();
  return dir;
}

/** sw.js as the build would emit it: the current manifest inlined as JSON. */
function writeSw() {
  const manifest = generatePrecacheManifest({ globDirectory: dir, globPatterns: GLOBS });
  writeFileSync(join(dir, "sw.js"), `precache(${JSON.stringify(manifest)})`);
}

describe("extractHtmlRefs", () => {
  it("collects local src/href values and skips external URLs", () => {
    const refs = extractHtmlRefs(
      `<script src="ui.js"></script><link href='a.css' />
       <a href="https://x.example"></a><img src="data:image/png;base64,AA" />
       <a href="page.html#frag"></a><a href="page.html?q=1"></a>`,
    );
    expect(refs).toEqual(["ui.js", "a.css", "page.html", "page.html"]);
  });
});

describe("extractCssRefs", () => {
  it("collects quoted and bare url() values, skipping data: URIs", () => {
    const refs = extractCssRefs(
      `a { background: url("x.png") } b { background: url('y.svg') }
       c { background: url(z.woff2) } d { background: url(data:image/png;base64,AA) }`,
    );
    expect(refs).toEqual(["x.png", "y.svg", "z.woff2"]);
  });
});

describe("extractWebmanifestRefs", () => {
  it("collects icon srcs and tolerates malformed JSON", () => {
    expect(
      extractWebmanifestRefs(JSON.stringify({ icons: [{ src: "a.png" }, { src: "b.png" }] })),
    ).toEqual(["a.png", "b.png"]);
    expect(extractWebmanifestRefs("{nope")).toEqual([]);
  });
});

describe("verifyPwa", () => {
  it("passes on a complete, freshly built app", () => {
    const root = fixture();
    const result = verifyPwa({ precache: GLOBS, globDirectory: root });
    expect(result.errors).toEqual([]);
    expect(result.checkedRefs).toBeGreaterThan(0);
  });

  it("flags a referenced file that is not covered by the precache globs", () => {
    const root = fixture();
    // Exists on disk + referenced from HTML, but no glob matches it.
    writeFileSync(join(root, "extra.css"), "body{}");
    writeFileSync(
      join(root, "index.html"),
      `<link href="style.css" rel="stylesheet" /><link href="extra.css" rel="stylesheet" />
       <script src="ui.js"></script>`,
    );
    writeSw();
    const { errors } = verifyPwa({ precache: GLOBS, globDirectory: root });
    expect(errors).toEqual([
      expect.stringContaining("./extra.css, which is not precached"),
    ]);
  });

  it("flags a reference to a file that does not exist", () => {
    const root = fixture();
    writeFileSync(
      join(root, "style.css"),
      `@font-face { src: url("./assets/missing.woff2"); }`,
    );
    writeSw();
    const { errors } = verifyPwa({ precache: GLOBS, globDirectory: root });
    expect(errors).toEqual([
      expect.stringContaining("./assets/missing.woff2, which does not exist"),
    ]);
  });

  it("flags a stale sw.js after an asset changed post-build", () => {
    const root = fixture();
    writeFileSync(join(root, "ui.js"), "console.log(2) // changed after build");
    const { errors } = verifyPwa({ precache: GLOBS, globDirectory: root });
    expect(errors).toEqual([
      expect.stringContaining("outdated revision for ./ui.js"),
    ]);
  });

  it("flags a missing sw.js", () => {
    const root = fixture();
    rmSync(join(root, "sw.js"));
    const { errors } = verifyPwa({ precache: GLOBS, globDirectory: root });
    expect(errors).toEqual([expect.stringContaining("sw.js not found")]);
  });

  it("does not require the sw.js self-reference to be precached", () => {
    const root = fixture();
    writeFileSync(
      join(root, "index.html"),
      `<link href="style.css" rel="stylesheet" /><script src="ui.js"></script>
       <script>navigator.serviceWorker.register("sw.js")</script><a href="sw.js">w</a>`,
    );
    writeSw();
    const { errors } = verifyPwa({ precache: GLOBS, globDirectory: root });
    expect(errors).toEqual([]);
  });

  // A worker is only ever named inside JS, which no extractor reads — so without
  // the `workers` config it is invisible and an uncached one ships silently.
  it("flags a worker that was built but not precached", () => {
    const root = fixture();
    writeFileSync(join(root, "ai-worker.js"), "onmessage = () => {}");
    const { errors } = verifyPwa({
      precache: GLOBS, // deliberately omits ai-worker.js
      globDirectory: root,
      workers: [{ entry: "ai-worker.ts", outfile: "ai-worker.js" }],
    });
    expect(errors).toEqual([
      expect.stringContaining("./ai-worker.js, which is not precached"),
    ]);
  });

  it("flags a declared worker whose bundle is missing entirely", () => {
    const root = fixture();
    const { errors } = verifyPwa({
      precache: GLOBS,
      globDirectory: root,
      workers: [{ entry: "ai-worker.ts", outfile: "ai-worker.js" }],
    });
    expect(errors).toEqual([
      expect.stringContaining("./ai-worker.js, which does not exist"),
    ]);
  });

  it("flags a malformed worker entry instead of silently passing", () => {
    const root = fixture();
    const { errors } = verifyPwa({
      precache: GLOBS,
      globDirectory: root,
      // `out` is a typo for `outfile` — buildPwa throws on this, so verify
      // reporting OK (having checked nothing) would be actively misleading.
      workers: [{ entry: "ai-worker.ts", out: "ai-worker.js" }],
    });
    expect(errors).toEqual([expect.stringContaining("workers[0] has no `outfile`")]);
  });

  it("flags a non-array workers config", () => {
    const root = fixture();
    const { errors } = verifyPwa({
      precache: GLOBS,
      globDirectory: root,
      workers: "ai-worker.js",
    });
    expect(errors).toEqual([expect.stringContaining("`workers` must be an array")]);
  });

  it("resolves an absolute worker outfile against globDirectory", () => {
    const root = fixture();
    writeFileSync(join(root, "ai-worker.js"), "onmessage = () => {}");
    const globs = [...GLOBS, "ai-worker.js"];
    const manifest = generatePrecacheManifest({
      globDirectory: root,
      globPatterns: globs,
    });
    writeFileSync(join(root, "sw.js"), `precache(${JSON.stringify(manifest)})`);

    const { errors } = verifyPwa({
      precache: globs,
      globDirectory: root,
      // The shape buildPwa is happy with; before rebasing this produced
      // ".//tmp/…/ai-worker.js" and a bogus "does not exist".
      workers: [{ entry: join(root, "ai-worker.ts"), outfile: join(root, "ai-worker.js") }],
    });
    expect(errors).toEqual([]);
  });

  it("passes when the worker is precached", () => {
    const root = fixture();
    writeFileSync(join(root, "ai-worker.js"), "onmessage = () => {}");
    const globs = [...GLOBS, "ai-worker.js"];
    const manifest = generatePrecacheManifest({
      globDirectory: root,
      globPatterns: globs,
    });
    writeFileSync(join(root, "sw.js"), `precache(${JSON.stringify(manifest)})`);

    const { errors } = verifyPwa({
      precache: globs,
      globDirectory: root,
      workers: [{ entry: "ai-worker.ts", outfile: "ai-worker.js" }],
    });
    expect(errors).toEqual([]);
  });
});
