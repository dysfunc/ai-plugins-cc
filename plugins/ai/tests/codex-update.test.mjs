import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installCodexUpstream } from "@ai-plugins-cc/codex-adapter";

// This file exercises the install routine through the same import path the
// umbrella's ai-companion.mjs uses, ensuring the umbrella's dependency on
// @ai-plugins-cc/codex-adapter resolves correctly inside the workspace.

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildFakeUpstreamTarball(tag, version) {
  const stage = mkdtemp("umbrella-fake-upstream-");
  const topDir = `codex-plugin-cc-${tag.replace(/^v/, "")}`;
  const root = path.join(stage, topDir);
  const pluginDir = path.join(root, "plugins", "codex");
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "codex", version }, null, 2)
  );
  fs.writeFileSync(
    path.join(pluginDir, "scripts", "codex-companion.mjs"),
    "#!/usr/bin/env node\nprocess.exit(0);\n",
    { mode: 0o755 }
  );

  const tarballPath = path.join(stage, "upstream.tar.gz");
  const result = spawnSync("tar", ["-czf", tarballPath, "-C", stage, topDir], { stdio: "pipe" });
  if (result.status !== 0) throw new Error(result.stderr?.toString() ?? "tar failed");
  return fs.readFileSync(tarballPath);
}

test("umbrella resolves @ai-plugins-cc/codex-adapter and installCodexUpstream is callable end-to-end", async () => {
  const tarball = buildFakeUpstreamTarball("v3.2.1", "3.2.1");
  const into = path.join(mkdtemp("umbrella-install-"), "codex-plugin-cc");

  // Point at a fixture package.json with no pinnedSha so the SHA gate
  // doesn't pick up the real adapter's pinned hash and reject the test
  // tarball. allowUnpinned then permits the unverified install path.
  const adapterPkgPath = path.join(mkdtemp("umbrella-pkg-"), "package.json");
  fs.writeFileSync(
    adapterPkgPath,
    JSON.stringify(
      { "ai-plugins-cc": { upstream: { repo: "openai/codex-plugin-cc", pinnedTag: null } } },
      null,
      2
    ),
    "utf8"
  );

  const result = await installCodexUpstream({
    tag: "v3.2.1",
    into,
    fetchImpl: async () => tarball,
    adapterPackageJson: adapterPkgPath,
    allowUnpinned: true
  });

  assert.equal(result.tag, "v3.2.1");
  assert.equal(result.version, "3.2.1");
  assert.equal(result.root, into);
});
