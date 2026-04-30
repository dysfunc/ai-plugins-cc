// Verify that /ai:setup's codex probe actually invokes the upstream
// `setup --json` rather than just sniffing env vars. We construct a fake
// upstream install on disk (a directory layout the codex-adapter's
// discoverCodexInstall accepts) with a tiny companion script that responds
// to `setup --json`, then run our verify subcommand against it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "ai-companion.mjs"
);

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFakeUpstreamCodex({ version = "1.0.4" } = {}) {
  const root = mkdtemp("ai-codex-probe-");
  const pluginDir = path.join(root, "plugins", "codex");
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "codex", version })
  );
  // The companion mirrors the upstream contract: setup --json returns a
  // structured report. Reads OPENAI_API_KEY for auth state — that env var
  // is on the codex-adapter's allowlist and passes through invokeCodexCommand
  // cleanly, so the test can flip auth without special-casing.
  const companionSource = `#!/usr/bin/env node
const args = process.argv.slice(2);
function flush(code) {
  let pending = 2;
  const done = () => { pending -= 1; if (pending === 0) process.exit(code); };
  process.stdout.end(done);
  process.stderr.end(done);
}
if (args[0] === "setup" && args.includes("--json")) {
  const loggedIn = Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
  const payload = {
    ready: loggedIn,
    node: { available: true, detail: process.version },
    codex: { available: true, detail: "codex-fake ${version}" },
    auth: {
      loggedIn,
      detail: loggedIn ? "API key is set" : "no codex auth detected"
    },
    sessionRuntime: { mode: "direct", label: "direct invocation" },
    reviewGateEnabled: false
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\\n");
  flush(0);
} else {
  process.stderr.write("fake-codex: unknown command\\n");
  flush(2);
}
`;
  const companionPath = path.join(pluginDir, "scripts", "codex-companion.mjs");
  fs.writeFileSync(companionPath, companionSource, { mode: 0o755 });
  return { root, companionPath };
}

function runVerify(env) {
  return spawnSync(process.execPath, [SCRIPT, "verify", "--provider=codex", "--json"], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 60_000
  });
}

test("verify --provider=codex invokes upstream setup --json when an install exists", () => {
  const { root } = writeFakeUpstreamCodex();
  const home = mkdtemp("ai-codex-home-");

  // Without OPENAI_API_KEY the upstream reports loggedIn: false.
  const notAuthed = runVerify({ HOME: home, CODEX_PLUGIN_PATH: root });
  assert.notEqual(notAuthed.status, 0, "no auth → not ready");
  const notAuthedPayload = JSON.parse(notAuthed.stdout);
  assert.equal(notAuthedPayload.providerId, "codex");
  assert.equal(notAuthedPayload.installed, true);
  assert.equal(notAuthedPayload.loggedIn, false);
  assert.ok(
    notAuthedPayload.raw?.upstream,
    "raw.upstream must contain the upstream's setup output, proving we actually invoked it"
  );

  // OPENAI_API_KEY is on the env allowlist, so it survives the invokeCodexCommand
  // boundary and the fake reports loggedIn: true.
  const authed = runVerify({ HOME: home, CODEX_PLUGIN_PATH: root, OPENAI_API_KEY: "fake-key" });
  assert.equal(authed.status, 0, `auth set → ready, got ${authed.stderr}`);
  const authedPayload = JSON.parse(authed.stdout);
  assert.equal(authedPayload.ready, true);
  assert.equal(authedPayload.loggedIn, true);
  assert.equal(authedPayload.raw?.upstream?.auth?.loggedIn, true);
});

test("verify --provider=codex still reports not-installed when no upstream is reachable", () => {
  const home = mkdtemp("ai-codex-home-");
  // Set CODEX_PLUGIN_PATH to a directory that exists but lacks the
  // codex-companion.mjs file — discovery rejects it, the probe falls
  // back to "not installed".
  const empty = mkdtemp("ai-codex-empty-");
  const result = runVerify({ HOME: home, CODEX_PLUGIN_PATH: empty });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.installed, false);
  assert.match(payload.detail, /Run \/ai:codex-update/);
});
