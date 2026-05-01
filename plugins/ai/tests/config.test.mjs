import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveProvider, resolveCompareProviders } from "../scripts/lib/config.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-config-test-"));
}

function withWorkspaceConfig(cwd, contents) {
  const dir = path.join(cwd, ".claude-plugin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ai.json"), JSON.stringify(contents), "utf8");
}

function withUserConfig(home, contents) {
  const dir = path.join(home, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ai-plugins-cc.json"), JSON.stringify(contents), "utf8");
}

test("resolveProvider: CLI flag wins over every other source", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  withWorkspaceConfig(cwd, { provider: "grok" });
  withUserConfig(home, { provider: "codex" });
  const env = { AI_PLUGINS_CC_DEFAULT_PROVIDER: "grok" };

  const result = resolveProvider({ cliProvider: "gemini", cwd, home, env });
  assert.deepEqual(result, { providerId: "gemini", source: "cli-flag" });
});

test("resolveProvider: workspace config beats user/env/default", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  withWorkspaceConfig(cwd, { provider: "grok" });
  withUserConfig(home, { provider: "codex" });
  const env = { AI_PLUGINS_CC_DEFAULT_PROVIDER: "gemini" };

  const result = resolveProvider({ cwd, home, env });
  assert.deepEqual(result, { providerId: "grok", source: "workspace-config" });
});

test("resolveProvider: user config beats env/default when no workspace config", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  withUserConfig(home, { provider: "codex" });
  const env = { AI_PLUGINS_CC_DEFAULT_PROVIDER: "gemini" };

  const result = resolveProvider({ cwd, home, env });
  assert.deepEqual(result, { providerId: "codex", source: "user-config" });
});

test("resolveProvider: env beats default", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  const env = { AI_PLUGINS_CC_DEFAULT_PROVIDER: "grok" };

  const result = resolveProvider({ cwd, home, env });
  assert.deepEqual(result, { providerId: "grok", source: "env" });
});

test("resolveProvider: falls back to gemini default", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();

  const result = resolveProvider({ cwd, home, env: {} });
  assert.deepEqual(result, { providerId: "gemini", source: "default" });
});

test("resolveProvider: unknown provider id raises a clear error and names the source", () => {
  assert.throws(
    () => resolveProvider({ cliProvider: "claude", cwd: makeTempDir(), home: makeTempDir(), env: {} }),
    /Provider "claude" \(from cli-flag\) is not registered/
  );
});

test("resolveCompareProviders: CLI list wins over config and default", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  withWorkspaceConfig(cwd, { compareProviders: ["gemini", "grok"] });
  withUserConfig(home, { compareProviders: ["codex"] });

  const result = resolveCompareProviders({ cliProviders: "grok,codex", cwd, home });
  assert.deepEqual(result.providerIds, ["grok", "codex"]);
  assert.equal(result.source, "cli-flag");
});

test("resolveCompareProviders: defaults to every registered provider", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  const result = resolveCompareProviders({ cwd, home });
  assert.equal(result.source, "default-all");
  assert.ok(result.providerIds.includes("gemini"));
  assert.ok(result.providerIds.includes("grok"));
  assert.ok(result.providerIds.includes("codex"));
});

test("resolveCompareProviders: invalid id in workspace config errors loudly", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  withWorkspaceConfig(cwd, { compareProviders: ["gemini", "claude"] });

  assert.throws(
    () => resolveCompareProviders({ cwd, home }),
    /Provider "claude" \(from workspace-compare\) is not registered/
  );
});

test("resolveCompareProviders: empty user-config array falls through to default", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  withUserConfig(home, { compareProviders: [] });
  const result = resolveCompareProviders({ cwd, home });
  assert.equal(result.source, "default-all");
  assert.ok(result.providerIds.length > 0);
});

test("resolveCompareProviders: empty workspace-config array falls through to default", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  withWorkspaceConfig(cwd, { compareProviders: [] });
  const result = resolveCompareProviders({ cwd, home });
  assert.equal(result.source, "default-all");
  assert.ok(result.providerIds.length > 0);
});

test("resolveCompareProviders: empty compareProviders falls through to user enabledProviders, not all-registered", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  withUserConfig(home, { enabledProviders: ["gemini", "codex"], compareProviders: [] });
  const result = resolveCompareProviders({ cwd, home });
  assert.equal(result.source, "user-enabled");
  assert.deepEqual(result.providerIds, ["gemini", "codex"]);
});

test("resolveCompareProviders: workspace enabledProviders beats user enabledProviders", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  withWorkspaceConfig(cwd, { enabledProviders: ["grok"] });
  withUserConfig(home, { enabledProviders: ["gemini", "codex"] });
  const result = resolveCompareProviders({ cwd, home });
  assert.equal(result.source, "workspace-enabled");
  assert.deepEqual(result.providerIds, ["grok"]);
});

test("resolveCompareProviders: explicit compareProviders still wins over enabledProviders", () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  withUserConfig(home, {
    enabledProviders: ["gemini", "grok", "codex"],
    compareProviders: ["gemini"]
  });
  const result = resolveCompareProviders({ cwd, home });
  assert.equal(result.source, "user-compare");
  assert.deepEqual(result.providerIds, ["gemini"]);
});
