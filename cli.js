#!/usr/bin/env node
// offline-kit CLI — thin wrappers over buildPwa() / verifyPwa() so a consumer
// needs no build script of its own: just `offline-kit build [--watch]` and
// `offline-kit verify`, plus an offline-kit.config.js
// (`export default { precache: [...] }`).
//
// buildPwa()/verifyPwa() stay exported for apps that want programmatic
// control / extra steps — this CLI is only the 90% convenience path.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildPwa } from "./build-pwa.js";
import { verifyPwa } from "./verify.js";

const CONFIG_FILE = "offline-kit.config.js";

const [command, ...flags] = process.argv.slice(2);

if (command !== "build" && command !== "verify") {
  console.error("Usage: offline-kit build [--watch] | offline-kit verify");
  process.exit(1);
}

const configPath = join(process.cwd(), CONFIG_FILE);
if (!existsSync(configPath)) {
  console.error(`offline-kit: no ${CONFIG_FILE} found in ${process.cwd()}`);
  process.exit(1);
}

const config = (await import(pathToFileURL(configPath).href)).default;
if (!config || typeof config !== "object") {
  console.error(`offline-kit: ${CONFIG_FILE} must \`export default\` a config object`);
  process.exit(1);
}

if (command === "build") {
  await buildPwa({ ...config, watch: flags.includes("--watch") });
} else {
  const { errors, manifest, checkedRefs } = verifyPwa(config);
  if (errors.length > 0) {
    console.error("offline-kit verify: FAILED");
    for (const error of errors) console.error(`  ✗ ${error}`);
    process.exit(1);
  }
  console.log(
    `offline-kit verify: OK — ${manifest.length} precache entries, ${checkedRefs} references checked`,
  );
}
