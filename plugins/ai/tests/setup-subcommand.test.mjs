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

function runCompanion(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: {
      // Inherit PATH/Node, but override HOME so we get a clean settings file.
      PATH: process.env.PATH,
      NODE: process.execPath,
      ...env
    },
    encoding: "utf8",
    timeout: 60_000
  });
}

test("ai-companion setup --json returns the expected top-level shape", () => {
  const home = mkdtemp("ai-setup-home-");
  const pluginData = mkdtemp("ai-setup-data-");
  const result = runCompanion(["setup", "--json"], { HOME: home, CLAUDE_PLUGIN_DATA: pluginData });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.ok(payload.providers, "providers map present");
  assert.ok(payload.settings, "settings present");
  assert.ok(payload.settingsFile.endsWith(".claude/ai-plugins-cc.json"));
  assert.deepEqual(payload.knownProviders.sort(), ["codex", "gemini", "grok"].sort());

  for (const id of payload.knownProviders) {
    const p = payload.providers[id];
    assert.ok(p, `providers.${id} present`);
    assert.equal(typeof p.ready, "boolean", `providers.${id}.ready is bool`);
    assert.equal(typeof p.detail, "string", `providers.${id}.detail is string`);
  }
});

test("ai-companion settings show --json reports defaults for a fresh HOME", () => {
  const home = mkdtemp("ai-settings-home-");
  const result = runCompanion(["settings", "show", "--json"], { HOME: home });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.settings.provider, null);
  assert.deepEqual(payload.settings.enabledProviders, []);
});

test("ai-companion settings enable persists to disk and reports the message", () => {
  const home = mkdtemp("ai-settings-home-");
  const result = runCompanion(["settings", "enable", "gemini", "--json"], { HOME: home });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "enable");
  assert.match(payload.message, /Enabled gemini/);

  const onDisk = JSON.parse(fs.readFileSync(payload.settingsFile, "utf8"));
  assert.deepEqual(onDisk.enabledProviders, ["gemini"]);
});

test("ai-companion settings disable rolls the default forward", () => {
  const home = mkdtemp("ai-settings-home-");
  runCompanion(["settings", "enable", "gemini"], { HOME: home });
  runCompanion(["settings", "enable", "grok"], { HOME: home });
  runCompanion(["settings", "set-default", "gemini"], { HOME: home });

  const result = runCompanion(["settings", "disable", "gemini", "--json"], { HOME: home });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.settings.provider, "grok", "default rolls forward when current default is disabled");
});

test("ai-companion verify --provider=<id> returns status code reflecting readiness", () => {
  const home = mkdtemp("ai-verify-home-");
  // Codex without an upstream install + no API key → not ready.
  const result = runCompanion(["verify", "--provider=codex", "--json"], { HOME: home });
  assert.notEqual(result.status, 0, "codex without upstream/auth must be not-ready");

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.providerId, "codex");
  assert.equal(payload.ready, false);
});

test("ai-companion settings rejects unknown provider ids", () => {
  const home = mkdtemp("ai-settings-home-");
  const result = runCompanion(["settings", "enable", "bogus", "--json"], { HOME: home });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Unknown provider "bogus"/);
});
