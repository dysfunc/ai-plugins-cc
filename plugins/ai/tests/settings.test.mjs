import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultUserConfigPath,
  disableProvider,
  enableProvider,
  readSettings,
  setCompareProviders,
  setDefaultProvider,
  writeSettings
} from "../scripts/lib/settings.mjs";

function makeFakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-settings-test-"));
}

test("readSettings returns a clean default when no config file exists", () => {
  const home = makeFakeHome();
  const settings = readSettings(home);
  assert.deepEqual(settings, { provider: null, enabledProviders: [], compareProviders: [] });
});

test("writeSettings creates ~/.claude/ai-plugins-cc.json atomically", () => {
  const home = makeFakeHome();
  const result = writeSettings(
    { provider: "gemini", enabledProviders: ["gemini"], compareProviders: ["gemini"] },
    home
  );
  assert.equal(result.filePath, defaultUserConfigPath(home));
  assert.equal(fs.existsSync(result.filePath), true);
  const parsed = JSON.parse(fs.readFileSync(result.filePath, "utf8"));
  assert.equal(parsed.provider, "gemini");
  // No leftover .tmp.* files
  const sibling = fs
    .readdirSync(path.dirname(result.filePath))
    .filter((name) => name.startsWith("ai-plugins-cc.json.tmp."));
  assert.equal(sibling.length, 0, "tmp file must be renamed away");
});

test("readSettings drops unknown provider ids when normalizing", () => {
  const home = makeFakeHome();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(
    defaultUserConfigPath(home),
    JSON.stringify({
      provider: "claude",
      enabledProviders: ["gemini", "claude", "grok"],
      compareProviders: ["claude", "grok"]
    }),
    "utf8"
  );
  const settings = readSettings(home);
  assert.equal(settings.provider, null, "unknown default provider drops to null");
  assert.deepEqual(settings.enabledProviders, ["gemini", "grok"], "registry filters enabled list");
  assert.deepEqual(settings.compareProviders, ["grok"], "registry filters compare list");
});

test("enableProvider adds and persists the provider", () => {
  const home = makeFakeHome();
  enableProvider("gemini", home);
  enableProvider("grok", home);
  const settings = readSettings(home);
  assert.deepEqual(settings.enabledProviders, ["gemini", "grok"]);
});

test("enableProvider rejects unknown provider ids", () => {
  const home = makeFakeHome();
  assert.throws(() => enableProvider("claude", home), /Unknown provider "claude"/);
});

test("disableProvider removes and reassigns default when current default is disabled", () => {
  const home = makeFakeHome();
  enableProvider("gemini", home);
  enableProvider("grok", home);
  setDefaultProvider("gemini", home);
  disableProvider("gemini", home);
  const settings = readSettings(home);
  assert.equal(settings.enabledProviders.includes("gemini"), false);
  assert.equal(settings.provider, "grok", "default rolls forward to first remaining enabled provider");
});

test("disableProvider removes from compareProviders too", () => {
  const home = makeFakeHome();
  enableProvider("gemini", home);
  enableProvider("grok", home);
  setCompareProviders(["gemini", "grok"], home);
  disableProvider("grok", home);
  const settings = readSettings(home);
  assert.deepEqual(settings.compareProviders, ["gemini"]);
});

test("setDefaultProvider auto-enables the new default if it wasn't already enabled", () => {
  const home = makeFakeHome();
  setDefaultProvider("codex", home);
  const settings = readSettings(home);
  assert.equal(settings.provider, "codex");
  assert.equal(settings.enabledProviders.includes("codex"), true);
});

test("setCompareProviders rejects unknown ids", () => {
  const home = makeFakeHome();
  assert.throws(() => setCompareProviders(["gemini", "bogus"], home), /Unknown provider "bogus"/);
});

test("ordering of enabledProviders follows the registry, not insertion order", () => {
  const home = makeFakeHome();
  enableProvider("codex", home);
  enableProvider("gemini", home);
  const settings = readSettings(home);
  // The registry order is gemini, grok, codex — so gemini must come first
  // even though codex was enabled first.
  assert.deepEqual(settings.enabledProviders, ["gemini", "codex"]);
});
