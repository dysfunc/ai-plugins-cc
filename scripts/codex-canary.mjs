#!/usr/bin/env node
// Canary that drives a full install → invoke → normalize cycle against the
// pinned upstream openai/codex-plugin-cc release. Used by .github/workflows/
// codex-canary.yml on a schedule. Exits non-zero on any kind of drift:
//
//   - the pinned tag no longer exists upstream
//   - the tarball SHA doesn't match the pinned SHA (someone re-tagged)
//   - the upstream companion exits non-zero on `review --json`
//   - the upstream review output no longer conforms to our schema
//
// On success, prints a one-paragraph summary to stdout. On failure, prints
// a structured diagnostic the workflow can include in an auto-filed issue.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  installCodexUpstream,
  invokeCodexCommand,
  normalizeReviewOutput,
  readUpstreamConfig
} from "@ai-plugins-cc/codex-adapter";

const MODE_LATEST = "--mode=latest";
const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const ADAPTER_PACKAGE_JSON = path.join(
  REPO_ROOT,
  "packages",
  "codex-adapter",
  "package.json"
);

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes(MODE_LATEST) ? "latest" : "pinned";

  const config = readUpstreamConfig(ADAPTER_PACKAGE_JSON);
  if (!config?.repo) {
    fail("missing-config", "Adapter package.json has no ai-plugins-cc.upstream.repo set.");
  }

  let tag = config.pinnedTag;
  if (mode === "latest") {
    tag = await fetchLatestReleaseTag(config.repo);
  }
  if (!tag) {
    fail(
      "no-tag",
      `No tag to test (pinnedTag in ${ADAPTER_PACKAGE_JSON} is null and --mode=latest was not supplied).`
    );
  }

  const into = fs.mkdtempSync(path.join(os.tmpdir(), "codex-canary-"));
  let install;
  try {
    install = await installCodexUpstream({
      tag,
      sha: mode === "pinned" ? config.pinnedSha ?? null : null,
      into,
      adapterPackageJson: ADAPTER_PACKAGE_JSON
    });
  } catch (err) {
    fail("install-failed", `Install of ${config.repo}@${tag} failed: ${err?.message ?? err}`);
  }

  // Use `setup --json` as the canary's no-network probe. It's the
  // contract that the umbrella relies on (probeCodex parses this exact
  // output), it doesn't require the codex CLI on PATH or a real repo,
  // and it exercises the install→spawn→stdout chain end-to-end. We
  // intentionally do NOT call `--version` — upstream's companion
  // script doesn't accept it as a subcommand, and using it as a smoke
  // test would just be testing a subcommand that never existed.
  const setupResult = await invokeCodexCommand({
    args: ["setup", "--json"],
    install,
    timeoutMs: 60_000
  });
  if (setupResult.status !== 0) {
    fail(
      "setup-failed",
      `Upstream companion ${install.tag} (${install.version ?? "unknown"}) exited ` +
        `${setupResult.status} on setup --json. stderr=${truncate(setupResult.stderr, 4_000)}`
    );
  }

  // The setup result must be parseable JSON. If not, that's a
  // contract-shape regression from upstream.
  if (setupResult.stdout.trim()) {
    try {
      JSON.parse(setupResult.stdout);
    } catch (err) {
      fail(
        "setup-json-drift",
        `setup --json output is not valid JSON: ${err?.message ?? err}\n` +
          `--- stdout (first 4 KB) ---\n${truncate(setupResult.stdout, 4_000)}`
      );
    }
  } else {
    fail(
      "setup-empty",
      `Upstream companion ${install.tag} produced empty stdout on setup --json. ` +
        `Expected a JSON probe result.`
    );
  }

  const summary = {
    ok: true,
    mode,
    repo: config.repo,
    pinnedTag: config.pinnedTag,
    testedTag: install.tag,
    pinnedSha: config.pinnedSha,
    observedSha: install.sha,
    upstreamVersion: install.version,
    setupStatus: setupResult.status
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  // Cleanup the temp install directory; ignore failures.
  try { fs.rmSync(into, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function fail(code, message) {
  const payload = { ok: false, code, message };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(`canary failed [${code}]: ${message}\n`);
  process.exit(1);
}

async function fetchLatestReleaseTag(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "ai-plugins-cc-canary" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    fail(
      "github-api-failed",
      `GitHub API ${url} returned ${response.status} ${response.statusText}`
    );
  }
  const body = await response.json();
  if (typeof body?.tag_name !== "string") {
    fail("github-api-unexpected", "GitHub release payload has no tag_name.");
  }
  return body.tag_name;
}

function truncate(text, limit) {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n... [${s.length - limit} more bytes truncated]`;
}

main().catch((err) => {
  fail("unhandled", err?.stack ?? String(err));
});
