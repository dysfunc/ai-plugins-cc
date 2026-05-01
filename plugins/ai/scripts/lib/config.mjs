import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProvider, listProviders } from "./providers.mjs";

const WORKSPACE_CONFIG_PATH = ".claude-plugin/ai.json";
const USER_CONFIG_PATH = ".claude/ai-plugins-cc.json";
const ENV_DEFAULT_PROVIDER = "AI_PLUGINS_CC_DEFAULT_PROVIDER";
const FALLBACK_PROVIDER = "gemini";

/**
 * Resolve the active provider for an /ai:* command.
 *
 * Precedence (high → low):
 *   1. CLI flag       — options.cliProvider
 *   2. Workspace      — <cwd>/.claude-plugin/ai.json { "provider": "..." }
 *   3. User           — <home>/.claude/ai-plugins-cc.json { "provider": "..." }
 *   4. Env            — AI_PLUGINS_CC_DEFAULT_PROVIDER
 *   5. Default        — "gemini"
 *
 * Returns { providerId, source } so callers can explain to the user where
 * the choice came from.
 */
export function resolveProvider(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;

  const candidates = [
    { source: "cli-flag", value: options.cliProvider },
    { source: "workspace-config", value: readProviderFromConfig(path.join(cwd, WORKSPACE_CONFIG_PATH)) },
    { source: "user-config", value: readProviderFromConfig(path.join(home, USER_CONFIG_PATH)) },
    { source: "env", value: env[ENV_DEFAULT_PROVIDER] },
    { source: "default", value: FALLBACK_PROVIDER }
  ];

  for (const candidate of candidates) {
    const value = candidate.value;
    if (!value) continue;
    if (!isProvider(value)) {
      throw new Error(
        `Provider "${value}" (from ${candidate.source}) is not registered. Known providers: ${listProviders().join(", ")}.`
      );
    }
    return { providerId: value, source: candidate.source };
  }

  // Unreachable — the default fallback always returns a value.
  throw new Error("resolveProvider could not determine a provider.");
}

function readProviderFromConfig(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof parsed?.provider === "string" ? parsed.provider : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the list of providers to use for /ai:compare.
 *
 * Precedence:
 *   1. CLI flag (comma-separated) — options.cliProviders
 *   2. Workspace config { "compareProviders": [...] }
 *   3. User config { "compareProviders": [...] }
 *   4. Default: every registered provider
 */
export function resolveCompareProviders(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();

  const fromCli = parseList(options.cliProviders);
  if (fromCli && fromCli.length > 0) return validateList(fromCli, "cli-flag");

  const fromWorkspace = readListFromConfig(path.join(cwd, WORKSPACE_CONFIG_PATH));
  if (fromWorkspace && fromWorkspace.length > 0) return validateList(fromWorkspace, "workspace-config");

  const fromUser = readListFromConfig(path.join(home, USER_CONFIG_PATH));
  if (fromUser && fromUser.length > 0) return validateList(fromUser, "user-config");

  return { providerIds: listProviders(), source: "default-all" };
}

function parseList(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}

function readListFromConfig(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(parsed?.compareProviders)) return parsed.compareProviders;
    return null;
  } catch {
    return null;
  }
}

function validateList(ids, source) {
  for (const id of ids) {
    if (!isProvider(id)) {
      throw new Error(
        `Provider "${id}" (from ${source}) is not registered. Known providers: ${listProviders().join(", ")}.`
      );
    }
  }
  return { providerIds: ids, source };
}
