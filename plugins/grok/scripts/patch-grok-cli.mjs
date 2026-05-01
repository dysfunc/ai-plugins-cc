#!/usr/bin/env node

// Workaround for a real upstream bug in @vibe-kit/grok-cli (verified against
// 0.0.34 / runtime version 1.0.1): the bundled `dist/grok/client.js`
// unconditionally attaches `search_parameters` (even with `mode: "off"`) to
// every chat / chatStream request. xAI rejects any request carrying that
// field on accounts without a Live Search license — they return:
//
//   410 "Live search is deprecated. Please switch to the Agent Tools API"
//
// Stripping the assignment lets the request go through. The script is
// idempotent: it leaves a marker comment so re-runs are no-ops. After any
// `npm install -g @vibe-kit/grok-cli` overwrites the install, this must be
// re-applied.
//
// Resolution order for the file to patch (high → low):
//   1. GROK_BIN env var, if it points at an existing file (resolves the bin
//      to its package install via the symlink target / parent directories).
//   2. The file `which grok` resolves to.
//   3. `npm root -g` / @vibe-kit/grok-cli/dist/grok/client.js.
//
// We follow the actual binary backing the user's runtime, not just whatever
// happens to be in npm's global prefix — this is honest about pnpm, custom
// node prefixes, and standalone Grok installs.
//
// On no match, the script fails closed with an actionable message rather
// than reporting "not-needed". A truly upstream-fixed CLI will be detected
// by the marker check and reported as `already-patched`.

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PATCH_MARKER = "/* ai-plugins-cc: live-search-off patched out */";
const ORIGINAL_PATTERN = /requestPayload\.search_parameters = searchOptions\.search_parameters;/g;
const CLIENT_RELATIVE = path.join("dist", "grok", "client.js");
const PACKAGE_FOLDER = path.join("@vibe-kit", "grok-cli");

function tryResolveGrokBinary() {
  if (process.env.GROK_BIN) {
    const explicit = path.resolve(process.env.GROK_BIN);
    if (fs.existsSync(explicit)) return explicit;
  }
  try {
    const located = execFileSync("which", ["grok"], { encoding: "utf8" }).trim();
    if (located && fs.existsSync(located)) return located;
  } catch {
    // not on PATH
  }
  return null;
}

function tryClientPathFromBinary(binPath) {
  // Resolve symlinks: npm installs `grok` as a shim that points at the
  // package's actual entry. The real CLI bundle lives next to that entry.
  let real;
  try {
    real = fs.realpathSync(binPath);
  } catch {
    return null;
  }
  // Walk up until we find the package root that contains dist/grok/client.js.
  let dir = path.dirname(real);
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, CLIENT_RELATIVE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function tryClientPathFromNpmGlobal() {
  let root;
  try {
    root = execSync("npm root -g", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  const candidate = path.join(root, PACKAGE_FOLDER, CLIENT_RELATIVE);
  return fs.existsSync(candidate) ? candidate : null;
}

function findClientPath() {
  const bin = tryResolveGrokBinary();
  if (bin) {
    const fromBinary = tryClientPathFromBinary(bin);
    if (fromBinary) return { path: fromBinary, source: `grok binary (${bin})` };
  }
  const fromNpm = tryClientPathFromNpmGlobal();
  if (fromNpm) return { path: fromNpm, source: "npm root -g" };
  throw new Error(
    `Could not locate @vibe-kit/grok-cli's client.js. ` +
      `Tried GROK_BIN, \`which grok\`, and \`npm root -g\`. ` +
      `Install Grok with \`npm install -g @vibe-kit/grok-cli\` and retry, ` +
      `or set GROK_BIN to an installed grok binary.`
  );
}

function patchClient(clientPath) {
  const original = fs.readFileSync(clientPath, "utf8");
  if (original.includes(PATCH_MARKER)) {
    return { status: "already-patched", path: clientPath, replacements: 0 };
  }
  const matches = original.match(ORIGINAL_PATTERN);
  if (!matches || matches.length === 0) {
    // Fail closed: an unmatched pattern means the upstream bundle changed
    // (could be fixed, could be different). Don't pretend success — surface
    // it so the user can re-evaluate whether the patch is still needed.
    throw new Error(
      `Could not find the expected \`requestPayload.search_parameters = ...\` ` +
        `assignment in ${clientPath}. The grok-cli bundle may have been updated ` +
        `upstream. Verify whether @vibe-kit/grok-cli still needs this patch by ` +
        `running a small prompt against xAI; if it works without 410, this ` +
        `script can be retired.`
    );
  }
  const patched = original.replace(ORIGINAL_PATTERN, `${PATCH_MARKER};`);
  fs.writeFileSync(clientPath, patched, "utf8");
  return { status: "patched", path: clientPath, replacements: matches.length };
}

function main() {
  const json = process.argv.includes("--json");
  let result;
  try {
    const located = findClientPath();
    result = { ok: true, source: located.source, ...patchClient(located.path) };
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
      `grok-cli patched: ${result.replacements} replacement(s) in ${result.path} (via ${result.source})\n`
    );
  }

  process.exit(result.ok ? 0 : 1);
}

main();
