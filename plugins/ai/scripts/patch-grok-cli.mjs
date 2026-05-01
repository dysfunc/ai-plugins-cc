#!/usr/bin/env node

// Workaround for a real upstream bug in @vibe-kit/grok-cli (verified against
// 0.0.34 / runtime version 1.0.1):
//
//   plugins/<host>/lib/node_modules/@vibe-kit/grok-cli/dist/grok/client.js
//
// unconditionally attaches `search_parameters` (even with `mode: "off"`) to
// every chat / chatStream request. xAI rejects any request carrying that
// field on accounts without a Live Search license — they return:
//
//   410 "Live search is deprecated. Please switch to the Agent Tools API"
//
// which is opaque (it sounds like a hard deprecation, but it's an account-
// scoped rejection). Stripping the assignment lets the request go through.
//
// This script is idempotent: it leaves a marker comment so re-runs detect
// an already-patched file. After `npm install -g @vibe-kit/grok-cli`
// overwrites the install, re-run this script to re-apply.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PATCH_MARKER = "/* ai-plugins-cc: live-search-off patched out */";
const ORIGINAL_PATTERN = /requestPayload\.search_parameters = searchOptions\.search_parameters;/g;
const CLIENT_RELATIVE = path.join("@vibe-kit", "grok-cli", "dist", "grok", "client.js");

function resolveGlobalNodeModules() {
  try {
    return execSync("npm root -g", { encoding: "utf8" }).trim();
  } catch (err) {
    throw new Error(`Could not resolve global node_modules via "npm root -g": ${err.message}`);
  }
}

function findClientPath() {
  const root = resolveGlobalNodeModules();
  const candidate = path.join(root, CLIENT_RELATIVE);
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `@vibe-kit/grok-cli is not installed globally. Expected ${candidate}. ` +
        `Run \`npm install -g @vibe-kit/grok-cli\` first.`
    );
  }
  return candidate;
}

function patchClient(clientPath) {
  const original = fs.readFileSync(clientPath, "utf8");
  const matches = original.match(ORIGINAL_PATTERN);
  if (!matches || matches.length === 0) {
    // Two possibilities: someone already neutralised the assignment, or
    // upstream removed it. Both are safe — nothing to do, no error.
    return {
      status: original.includes(PATCH_MARKER) ? "already-patched" : "not-needed",
      path: clientPath,
      replacements: 0
    };
  }
  const patched = original.replace(ORIGINAL_PATTERN, `${PATCH_MARKER};`);
  fs.writeFileSync(clientPath, patched, "utf8");
  return { status: "patched", path: clientPath, replacements: matches.length };
}

function main() {
  const json = process.argv.includes("--json");
  let result;
  try {
    result = { ok: true, ...patchClient(findClientPath()) };
  } catch (err) {
    result = { ok: false, error: err?.message ?? String(err) };
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    process.stderr.write(`grok-patch: ${result.error}\n`);
  } else if (result.status === "already-patched") {
    process.stdout.write(`grok-cli already patched: ${result.path}\n`);
  } else if (result.status === "patched") {
    process.stdout.write(
      `grok-cli patched: ${result.replacements} replacement(s) in ${result.path}\n`
    );
  } else if (result.status === "not-needed") {
    process.stdout.write(`grok-cli unchanged: no live-search assignment present (${result.path}).\n`);
  }

  process.exit(result.ok ? 0 : 1);
}

main();
