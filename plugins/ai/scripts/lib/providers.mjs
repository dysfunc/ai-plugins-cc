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
 * symlink. Returns an absolute path; throws SiblingPluginMissingError if none
 * of the candidate locations contain the file. Callers should distinguish
 * this from "the CLI is missing" — the right remediation is to install the
 * sibling Claude plugin, not the underlying CLI.
 *
 * Candidate locations checked, in order:
 *   1. Workspace dev clone:        <umbrella>/../<provider>/scripts/<provider>-companion.mjs
 *   2. Versioned marketplace cache: <umbrella>/../../<provider>/<version>/scripts/...
 *      (uses the highest version directory found)
 */
export class SiblingPluginMissingError extends Error {
  constructor(providerId, searchedPaths) {
    super(
      `Could not locate the ${providerId} companion script. The sibling ` +
        `Claude plugin "${providerId}" does not appear to be installed. ` +
        `Install it via /plugin install ${providerId}@ai-plugins-cc, ` +
        `or run /ai:setup from a workspace clone.`
    );
    this.name = "SiblingPluginMissingError";
    this.providerId = providerId;
    this.searchedPaths = searchedPaths;
  }
}

export function resolveSiblingCompanionPath(providerId) {
  // Reject any providerId that isn't in the registered set BEFORE
  // interpolating it into a path — otherwise a tainted providerId like
  // "../../etc" or a literal dot path would escape the umbrella's
  // sibling directory. Defence-in-depth; today every call site already
  // validates, but the function itself is the trust boundary.
  if (!ALLOWED_PROVIDER_IDS.has(providerId)) {
    throw new Error(
      `resolveSiblingCompanionPath: unknown providerId "${providerId}". ` +
        `Expected one of: ${[...ALLOWED_PROVIDER_IDS].join(", ")}.`
    );
  }

  const root = pluginRoot();
  const filename = `${providerId}-companion.mjs`;
  const relative = path.join("scripts", filename);

  // Workspace dev clone: plugins/ai sits next to plugins/<provider>/.
  const devSibling = path.resolve(root, "..", providerId, relative);

  // Marketplace cache: each plugin lives at <cache>/<marketplace>/<plugin>/<version>/.
  // The umbrella is at <cache>/<marketplace>/ai/<version>/, so its sibling
  // <provider> dir lives one level up from the umbrella's plugin dir, then
  // a version subdirectory. We pick the highest version present.
  const marketplaceParent = path.resolve(root, "..", "..", providerId);
  const marketplaceVersioned = listVersionsDescending(marketplaceParent).map((version) =>
    path.join(marketplaceParent, version, relative)
  );

  // Bound every candidate to the umbrella's parent or grandparent
  // directory. Without this, a malicious CLAUDE_PLUGIN_ROOT (like
  // "/tmp/evil/plugins/ai") combined with a legitimate-looking
  // providerId could resolve to an attacker-controlled script outside
  // the marketplace tree. We accept candidates whose real path is
  // either under root/.. (workspace dev) or root/../.. (marketplace
  // cache).
  const allowedRoots = [path.resolve(root, ".."), path.resolve(root, "..", "..")];
  const candidates = [devSibling, ...marketplaceVersioned].filter((candidate) =>
    allowedRoots.some((allowedRoot) => isUnder(candidate, allowedRoot))
  );

  const found = firstExisting(candidates);
  if (!found) {
    throw new SiblingPluginMissingError(providerId, candidates);
  }
  return found;
}

const ALLOWED_PROVIDER_IDS = new Set(["gemini", "grok", "codex"]);

function isUnder(candidate, ancestor) {
  const relativeFromAncestor = path.relative(ancestor, candidate);
  // path.relative returns a string starting with ".." (or an absolute
  // path on Windows) when `candidate` escapes `ancestor`. We accept
  // anything else.
  return (
    relativeFromAncestor !== "" &&
    !relativeFromAncestor.startsWith("..") &&
    !path.isAbsolute(relativeFromAncestor)
  );
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
