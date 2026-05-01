// Provider registry. The umbrella dispatches commands to one or more
// providers; this module is the single place that knows how to reach each.
//
// In-house providers (gemini, grok) are reached by spawning their companion
// script directly. We resolve the path at runtime from a small set of
// well-known locations (workspace dev clone, marketplace cache) instead of
// importing the sibling plugin's `meta` module. That keeps each plugin
// bundle-independent: the umbrella plugin can be shipped through the
// marketplace without resolving sibling-plugin imports at runtime.
//
// External providers (codex) are reached through @ai-plugins-cc/codex-adapter,
// which discovers and subprocess-invokes upstream openai/codex-plugin-cc.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { invokeCodexCommand, discoverCodexInstall } from "@ai-plugins-cc/codex-adapter";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT
    ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
    : path.resolve(HERE, "..", "..");
}

function listVersionsDescending(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Find a sibling provider's companion script without depending on a workspace
 * symlink. Returns an absolute path; throws if none of the candidate locations
 * contain the file (caller decides how to surface).
 */
export function resolveSiblingCompanionPath(providerId) {
  const root = pluginRoot();
  const filename = `${providerId}-companion.mjs`;
  const relative = path.join("scripts", filename);

  const devSibling = path.resolve(root, "..", providerId, relative);
  const marketplaceParent = path.resolve(root, "..", "..", providerId);
  const marketplaceVersioned = listVersionsDescending(marketplaceParent).map((version) =>
    path.join(marketplaceParent, version, relative)
  );
  const marketplaceFlat = path.resolve(root, "..", providerId, relative);

  const found = firstExisting([devSibling, marketplaceFlat, ...marketplaceVersioned]);
  if (!found) {
    throw new Error(
      `Could not locate the ${providerId} companion script (looked next to the umbrella ` +
        `plugin at ${devSibling} and under ${marketplaceParent}). ` +
        `Install the @ai-plugins-cc/${providerId} plugin via the marketplace, ` +
        `or run /ai:setup from a workspace clone.`
    );
  }
  return found;
}

const PROVIDERS = {
  gemini: {
    id: "gemini",
    label: "Gemini",
    commandPrefix: "gemini",
    kind: "in-house",
    get companionPath() {
      return resolveSiblingCompanionPath("gemini");
    }
  },
  grok: {
    id: "grok",
    label: "Grok",
    commandPrefix: "grok",
    kind: "in-house",
    get companionPath() {
      return resolveSiblingCompanionPath("grok");
    }
  },
  codex: {
    id: "codex",
    label: "Codex",
    commandPrefix: "codex",
    kind: "external",
    invoke: invokeCodexCommand,
    probe: discoverCodexInstall
  }
};

export function listProviders() {
  return Object.keys(PROVIDERS);
}

export function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(
      `Unknown provider "${id}". Known providers: ${listProviders().join(", ")}.`
    );
  }
  return provider;
}

export function isProvider(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}
