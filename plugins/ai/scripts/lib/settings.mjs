// Read/write the user's ai-plugins-cc settings file.
//
// The file lives at ~/.claude/ai-plugins-cc.json and overlays whatever the
// workspace .claude-plugin/ai.json sets. Schema:
//
//   {
//     "provider": "gemini",                    // active default for /ai:review etc.
//     "enabledProviders": ["gemini", "grok"],  // /ai:settings disable <id> removes; enable <id> adds
//     "compareProviders": ["gemini", "grok"]   // ordering used by /ai:compare default fan-out
//   }
//
// Every mutation writes via temp file + rename for atomicity.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProvider, listProviders } from "./providers.mjs";

const USER_CONFIG_DIR = path.join(".claude");
const USER_CONFIG_FILE = "ai-plugins-cc.json";

export function defaultUserConfigPath(home = os.homedir()) {
  return path.join(home, USER_CONFIG_DIR, USER_CONFIG_FILE);
}

export function readSettings(home = os.homedir()) {
  const filePath = defaultUserConfigPath(home);
  if (!fs.existsSync(filePath)) return defaultSettings();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeSettings(parsed);
  } catch {
    return defaultSettings();
  }
}

export function writeSettings(settings, home = os.homedir()) {
  const filePath = defaultUserConfigPath(home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = normalizeSettings(settings);
  const suffix = `${process.pid}.${randomBytes(4).toString("hex")}`;
  const tmp = `${filePath}.tmp.${suffix}`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
  return { filePath, settings: normalized };
}

export function enableProvider(id, home = os.homedir()) {
  assertKnownProvider(id);
  const current = readSettings(home);
  const enabled = new Set(current.enabledProviders);
  enabled.add(id);
  const next = { ...current, enabledProviders: orderedList(enabled) };
  return writeSettings(next, home);
}

export function disableProvider(id, home = os.homedir()) {
  assertKnownProvider(id);
  const current = readSettings(home);
  const enabled = new Set(current.enabledProviders);
  enabled.delete(id);
  const compare = current.compareProviders.filter((p) => p !== id);
  let provider = current.provider;
  if (provider === id) provider = orderedList(enabled)[0] ?? null;
  const next = {
    ...current,
    provider,
    enabledProviders: orderedList(enabled),
    compareProviders: compare
  };
  return writeSettings(next, home);
}

export function setDefaultProvider(id, home = os.homedir()) {
  assertKnownProvider(id);
  const current = readSettings(home);
  const enabled = new Set(current.enabledProviders);
  enabled.add(id);
  const next = {
    ...current,
    provider: id,
    enabledProviders: orderedList(enabled)
  };
  return writeSettings(next, home);
}

export function setCompareProviders(ids, home = os.homedir()) {
  for (const id of ids) assertKnownProvider(id);
  const current = readSettings(home);
  const next = { ...current, compareProviders: [...ids] };
  return writeSettings(next, home);
}

function defaultSettings() {
  return {
    provider: null,
    enabledProviders: [],
    compareProviders: []
  };
}

function normalizeSettings(raw) {
  const known = new Set(listProviders());
  const enabled = Array.isArray(raw?.enabledProviders)
    ? raw.enabledProviders.filter((id) => known.has(id))
    : [];
  const compare = Array.isArray(raw?.compareProviders)
    ? raw.compareProviders.filter((id) => known.has(id))
    : [];
  let provider = typeof raw?.provider === "string" && known.has(raw.provider) ? raw.provider : null;
  if (provider && !enabled.includes(provider)) {
    enabled.unshift(provider);
  }
  return {
    provider,
    enabledProviders: orderedList(new Set(enabled)),
    compareProviders: compare
  };
}

function orderedList(set) {
  // Preserve registry ordering (gemini, grok, codex, …) for stable display.
  return listProviders().filter((id) => set.has(id));
}

function assertKnownProvider(id) {
  if (!isProvider(id)) {
    throw new Error(
      `Unknown provider "${id}". Known providers: ${listProviders().join(", ")}.`
    );
  }
}
