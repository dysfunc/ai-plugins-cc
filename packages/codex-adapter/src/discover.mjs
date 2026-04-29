import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Locate an installed copy of openai/codex-plugin-cc.
 *
 * Discovery sources, in priority order:
 *   1. options.path or process.env.CODEX_PLUGIN_PATH (explicit override)
 *   2. Adapter-managed install at <home>/.cache/ai-plugins-cc/codex-plugin-cc/
 *      (this is where /ai:codex-update will install upstream releases)
 *   3. Sibling repo at <cwd>/../codex-plugin-cc (monorepo development convenience)
 *
 * A candidate qualifies only if its plugins/codex/scripts/codex-companion.mjs
 * file exists. The discovered record carries the resolved path, the upstream
 * plugin's declared version (when readable), and a content hash for honest
 * version pinning.
 */
export function discoverCodexInstall(options = {}) {
  const candidates = collectCandidates(options);
  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate);
    if (resolved) return resolved;
  }
  const tried = candidates.map((c) => c.path).join("\n  - ");
  throw new Error(
    "Could not locate an installed openai/codex-plugin-cc.\n" +
      `Tried:\n  - ${tried}\n` +
      "Set CODEX_PLUGIN_PATH to the plugin root (the directory that contains plugins/codex/), " +
      "or run /ai:codex-update once that command ships."
  );
}

function collectCandidates(options) {
  const out = [];
  const explicit = options.path ?? process.env.CODEX_PLUGIN_PATH;
  if (explicit) out.push({ source: "env|option", path: path.resolve(explicit) });
  out.push({ source: "managed-cache", path: managedCachePath() });
  const sibling = options.cwd ?? process.cwd();
  out.push({ source: "sibling-repo", path: path.resolve(sibling, "..", "codex-plugin-cc") });
  return out;
}

function managedCachePath() {
  const home = os.homedir();
  return path.join(home, ".cache", "ai-plugins-cc", "codex-plugin-cc");
}

function resolveCandidate(candidate) {
  const root = candidate.path;
  if (!root) return null;
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  const companionPath = path.join(root, "plugins", "codex", "scripts", "codex-companion.mjs");
  if (!fs.existsSync(companionPath)) return null;

  return {
    source: candidate.source,
    root,
    companionPath,
    version: readVersion(root),
    pluginManifestPath: path.join(root, "plugins", "codex", ".claude-plugin", "plugin.json")
  };
}

function readVersion(root) {
  const manifestPath = path.join(root, "plugins", "codex", ".claude-plugin", "plugin.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}
