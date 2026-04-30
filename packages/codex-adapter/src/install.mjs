import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ADAPTER_PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));
const DEFAULT_REPO = "openai/codex-plugin-cc";

/**
 * Install upstream openai/codex-plugin-cc into a managed cache directory.
 *
 * options:
 *   - tag        override the pinnedTag from the adapter's package.json
 *   - sha        override the pinnedSha (SHA-256 of the GitHub tarball)
 *   - repo       override the upstream repo (default: openai/codex-plugin-cc)
 *   - into       target install directory (default: ~/.cache/ai-plugins-cc/codex-plugin-cc)
 *   - fetchImpl  async fn(url) → Buffer (default: built-in fetch)
 *   - extractImpl async fn(tarballPath, destDir) → void (default: shell `tar -xzf`)
 *   - adapterPackageJson  path to the package.json holding the pinned config
 *   - pin        if true, write observedSha back to the adapter's package.json
 *               (or to options.adapterPackageJson if provided). Skipped with a
 *               warning when the target is inside node_modules.
 *
 * Returns { root, repo, tag, sha, version, replaced, pin? }.
 */
export async function installCodexUpstream(options = {}) {
  const config = readUpstreamConfig(options.adapterPackageJson ?? ADAPTER_PACKAGE_JSON);
  const repo = options.repo ?? config.repo ?? DEFAULT_REPO;
  const tag = options.tag ?? config.pinnedTag;
  if (!tag) {
    throw new Error(
      "No upstream tag pinned. Set ai-plugins-cc.upstream.pinnedTag in @ai-plugins-cc/codex-adapter's " +
        "package.json, or pass options.tag explicitly."
    );
  }
  const expectedSha = options.sha ?? config.pinnedSha ?? null;
  const into = options.into ?? defaultManagedCachePath();
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const extractImpl = options.extractImpl ?? defaultExtract;

  const url =
    options.url ??
    `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(tag)}`;
  const tarball = await fetchImpl(url);
  if (!Buffer.isBuffer(tarball)) {
    throw new Error("fetchImpl must return a Buffer of the gzipped tarball.");
  }

  const observedSha = createHash("sha256").update(tarball).digest("hex");
  if (expectedSha && expectedSha !== observedSha) {
    throw new Error(
      `Upstream tarball SHA mismatch for ${repo}@${tag}.\n` +
        `  expected: ${expectedSha}\n` +
        `  observed: ${observedSha}\n` +
        "Refusing to install. If the upstream release is legitimately new, update " +
        "ai-plugins-cc.upstream.pinnedSha in @ai-plugins-cc/codex-adapter's package.json."
    );
  }

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-install-"));
  const tarballPath = path.join(stagingRoot, "upstream.tar.gz");
  fs.writeFileSync(tarballPath, tarball);

  const extractDir = path.join(stagingRoot, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  await extractImpl(tarballPath, extractDir);

  // GitHub tarballs contain a single top-level directory named "<repo>-<tag>".
  const extractedTop = readSingleSubdir(extractDir);
  if (!extractedTop) {
    throw new Error(
      `Upstream tarball did not contain a single top-level directory in ${extractDir}.`
    );
  }

  // Atomic-ish swap: stage at a sibling .new path, then rename.
  fs.mkdirSync(path.dirname(into), { recursive: true });
  const stagedFinal = `${into}.new-${process.pid}`;
  if (fs.existsSync(stagedFinal)) {
    fs.rmSync(stagedFinal, { recursive: true, force: true });
  }
  fs.renameSync(extractedTop, stagedFinal);

  const replaced = fs.existsSync(into);
  if (replaced) {
    const trash = `${into}.old-${process.pid}-${Date.now()}`;
    fs.renameSync(into, trash);
    fs.rmSync(trash, { recursive: true, force: true });
  }
  fs.renameSync(stagedFinal, into);

  // Best-effort cleanup of the staging tree.
  try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* leave a stray temp dir */ }

  let pin = null;
  if (options.pin) {
    pin = pinObservedSha(observedSha, options.adapterPackageJson ?? ADAPTER_PACKAGE_JSON);
  }

  return {
    root: into,
    repo,
    tag,
    sha: observedSha,
    version: readPluginVersion(into),
    replaced,
    pin
  };
}

/**
 * Write `pinnedSha = sha` into the codex-adapter's package.json under
 * `ai-plugins-cc.upstream`. Returns { written, packageJsonPath, sha,
 * reason? }. Refuses to write when the target lives inside node_modules
 * (pinning is a maintainer task that mutates the source tree).
 */
export function pinObservedSha(sha, packageJsonPath = ADAPTER_PACKAGE_JSON) {
  const NM = `${path.sep}node_modules${path.sep}`;
  if (packageJsonPath.includes(NM)) {
    return {
      written: false,
      packageJsonPath,
      sha,
      reason:
        "Refusing to write to a package.json inside node_modules. Pinning is a " +
        "maintainer task — run /ai:codex-update --pin from a clone of the " +
        "ai-plugins-cc repo, then commit the SHA bump."
    };
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (err) {
    return {
      written: false,
      packageJsonPath,
      sha,
      reason: `Could not read package.json: ${err.message}`
    };
  }
  if (!pkg["ai-plugins-cc"]) pkg["ai-plugins-cc"] = {};
  if (!pkg["ai-plugins-cc"].upstream) pkg["ai-plugins-cc"].upstream = {};
  pkg["ai-plugins-cc"].upstream.pinnedSha = sha;

  const suffix = `${process.pid}.${randomBytes(4).toString("hex")}`;
  const tmp = `${packageJsonPath}.tmp.${suffix}`;
  fs.writeFileSync(tmp, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, packageJsonPath);

  return { written: true, packageJsonPath, sha };
}

export function readUpstreamConfig(packageJsonPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return pkg["ai-plugins-cc"]?.upstream ?? {};
  } catch {
    return {};
  }
}

function defaultManagedCachePath() {
  return path.join(os.homedir(), ".cache", "ai-plugins-cc", "codex-plugin-cc");
}

async function defaultFetch(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Upstream fetch failed: ${response.status} ${response.statusText} for ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer;
}

function defaultExtract(tarballPath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", tarballPath, "-C", destDir], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with status ${code}: ${stderr.trim()}`));
    });
  });
}

function readSingleSubdir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length !== 1) return null;
  return path.join(dir, entries[0].name);
}

function readPluginVersion(installRoot) {
  const manifestPath = path.join(installRoot, "plugins", "codex", ".claude-plugin", "plugin.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}
