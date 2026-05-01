import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { discoverCodexInstall } from "@ai-plugins-cc/codex-adapter";
import { writeFakeCodexInstall } from "./fake-codex-install.mjs";

function withEnv(key, value, fn) {
  const previous = process.env[key];
  if (value === null) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

// Isolate every test from the developer's real ~/.cache. discover.mjs
// prefers the managed-cache path under os.homedir() over a sibling-repo
// install, so a developer who ran /ai:codex-update once would shadow the
// fixture installs the tests rely on. Override HOME to a fresh temp dir
// per test run.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-home-"));
process.env.HOME = TEST_HOME;

test("discoverCodexInstall finds the install at CODEX_PLUGIN_PATH", () => {
  const fake = writeFakeCodexInstall();
  const result = withEnv("CODEX_PLUGIN_PATH", fake.root, () => discoverCodexInstall());
  assert.equal(result.root, fake.root);
  assert.equal(result.companionPath, fake.companionPath);
  assert.equal(result.version, "1.0.4");
});

test("discoverCodexInstall accepts an explicit options.path override", () => {
  const fake = writeFakeCodexInstall({ version: "2.0.0" });
  const result = withEnv("CODEX_PLUGIN_PATH", null, () => discoverCodexInstall({ path: fake.root }));
  assert.equal(result.root, fake.root);
  assert.equal(result.version, "2.0.0");
});

test("discoverCodexInstall finds a sibling-repo install when CWD has one", () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cwd-"));
  const sibling = path.join(cacheRoot, "codex-plugin-cc");
  fs.mkdirSync(path.join(sibling, "plugins", "codex", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(sibling, "plugins", "codex", ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(sibling, "plugins", "codex", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "codex", version: "9.9.9" }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(sibling, "plugins", "codex", "scripts", "codex-companion.mjs"),
    "#!/usr/bin/env node\nprocess.exit(0);\n",
    { mode: 0o755 }
  );
  // The "current dir" is a sibling of codex-plugin-cc.
  const cwd = path.join(cacheRoot, "ai-plugins-cc");
  fs.mkdirSync(cwd, { recursive: true });

  const result = withEnv("CODEX_PLUGIN_PATH", null, () => discoverCodexInstall({ cwd }));
  assert.equal(result.root, sibling);
  assert.equal(result.version, "9.9.9");
});

test("discoverCodexInstall throws a helpful error when nothing is found", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "codex-empty-"));
  withEnv("CODEX_PLUGIN_PATH", null, () => {
    assert.throws(
      () => discoverCodexInstall({ cwd: empty, path: path.join(empty, "nope") }),
      /Could not locate an installed openai\/codex-plugin-cc/
    );
  });
});

test("discoverCodexInstall rejects a path that lacks the companion script", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-incomplete-"));
  fs.mkdirSync(path.join(root, "plugins", "codex"), { recursive: true });
  // No scripts/codex-companion.mjs here.
  withEnv("CODEX_PLUGIN_PATH", root, () => {
    assert.throws(
      () => discoverCodexInstall({ cwd: root }),
      /Could not locate/
    );
  });
});
