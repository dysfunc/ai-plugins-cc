import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installCodexUpstream } from "@ai-plugins-cc/codex-adapter";

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Build a gzipped tar that mimics a GitHub source archive: a single top-level
// directory whose name is "<repo-tail>-<tag>", containing a minimal codex plugin
// tree with a manifest version. Returns { tarball: Buffer, expectedTopDirName }.
function buildFakeUpstreamTarball({ tag = "v9.9.9", version = "9.9.9" } = {}) {
  const stage = mkdtemp("fake-upstream-stage-");
  const topDir = `codex-plugin-cc-${tag.replace(/^v/, "")}`;
  const root = path.join(stage, topDir);
  const pluginDir = path.join(root, "plugins", "codex");
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "codex", version, description: "fake upstream" }, null, 2)
  );
  fs.writeFileSync(
    path.join(pluginDir, "scripts", "codex-companion.mjs"),
    "#!/usr/bin/env node\nprocess.exit(0);\n",
    { mode: 0o755 }
  );

  const tarballPath = path.join(stage, "upstream.tar.gz");
  const result = spawnSync("tar", ["-czf", tarballPath, "-C", stage, topDir], { stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`tar -czf failed: ${result.stderr?.toString() ?? "(unknown)"}`);
  }
  const tarball = fs.readFileSync(tarballPath);
  return { tarball, expectedTopDirName: topDir };
}

function fakeFetchReturning(buffer) {
  return async (_url) => buffer;
}

test("installCodexUpstream installs a tarball, exposes the resolved version, atomic-renames into place", async () => {
  const { tarball } = buildFakeUpstreamTarball({ tag: "v9.9.9", version: "9.9.9" });
  const into = path.join(mkdtemp("install-target-"), "codex-plugin-cc");

  const result = await installCodexUpstream({
    tag: "v9.9.9",
    into,
    fetchImpl: fakeFetchReturning(tarball)
  });

  assert.equal(result.root, into);
  assert.equal(result.tag, "v9.9.9");
  assert.equal(result.version, "9.9.9");
  assert.equal(typeof result.sha, "string");
  assert.equal(result.sha.length, 64);
  assert.equal(result.replaced, false);

  const companion = path.join(into, "plugins", "codex", "scripts", "codex-companion.mjs");
  assert.equal(fs.existsSync(companion), true, `expected ${companion} to exist after install`);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(into, "plugins", "codex", ".claude-plugin", "plugin.json"), "utf8")
  );
  assert.equal(manifest.version, "9.9.9");
});

test("installCodexUpstream replaces an existing install on subsequent runs", async () => {
  const into = path.join(mkdtemp("install-replace-"), "codex-plugin-cc");
  const first = buildFakeUpstreamTarball({ tag: "v1.0.0", version: "1.0.0" });
  await installCodexUpstream({ tag: "v1.0.0", into, fetchImpl: fakeFetchReturning(first.tarball) });
  const before = JSON.parse(
    fs.readFileSync(path.join(into, "plugins", "codex", ".claude-plugin", "plugin.json"), "utf8")
  );
  assert.equal(before.version, "1.0.0");

  const second = buildFakeUpstreamTarball({ tag: "v1.1.0", version: "1.1.0" });
  const result = await installCodexUpstream({
    tag: "v1.1.0",
    into,
    fetchImpl: fakeFetchReturning(second.tarball)
  });
  assert.equal(result.replaced, true);
  assert.equal(result.version, "1.1.0");
  const after = JSON.parse(
    fs.readFileSync(path.join(into, "plugins", "codex", ".claude-plugin", "plugin.json"), "utf8")
  );
  assert.equal(after.version, "1.1.0");
});

test("installCodexUpstream verifies SHA-256 when pinnedSha is provided", async () => {
  const { tarball } = buildFakeUpstreamTarball({ tag: "v2.0.0" });
  const correctSha = createHash("sha256").update(tarball).digest("hex");
  const into = path.join(mkdtemp("install-sha-ok-"), "codex-plugin-cc");

  const ok = await installCodexUpstream({
    tag: "v2.0.0",
    sha: correctSha,
    into,
    fetchImpl: fakeFetchReturning(tarball)
  });
  assert.equal(ok.sha, correctSha);
});

test("installCodexUpstream refuses to install when SHA mismatches and leaves the target untouched", async () => {
  const { tarball } = buildFakeUpstreamTarball({ tag: "v2.0.0" });
  const wrongSha = "0".repeat(64);
  const targetParent = mkdtemp("install-sha-bad-");
  const into = path.join(targetParent, "codex-plugin-cc");

  await assert.rejects(
    installCodexUpstream({
      tag: "v2.0.0",
      sha: wrongSha,
      into,
      fetchImpl: fakeFetchReturning(tarball)
    }),
    /SHA mismatch/
  );

  // Nothing should have been written under the target.
  assert.equal(fs.existsSync(into), false, "no install on SHA mismatch");
});

test("installCodexUpstream throws a clear error when no tag is pinned and none is passed", async () => {
  const adapterPkgPath = path.join(mkdtemp("install-noconfig-"), "package.json");
  fs.writeFileSync(
    adapterPkgPath,
    JSON.stringify({ "ai-plugins-cc": { upstream: { repo: "openai/codex-plugin-cc", pinnedTag: null } } }),
    "utf8"
  );

  await assert.rejects(
    installCodexUpstream({
      adapterPackageJson: adapterPkgPath,
      fetchImpl: fakeFetchReturning(Buffer.from("doesntmatter"))
    }),
    /No upstream tag pinned/
  );
});
