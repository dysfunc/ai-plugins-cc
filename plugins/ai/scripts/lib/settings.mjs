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
// Every mutation goes through `withLock` (advisory lock file with stale-PID
// detection) followed by an atomic temp + rename. /ai:setup and /ai:settings
// frequently run in quick succession from different subprocesses, and read-
// modify-write semantics need to be serialized across them.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProvider, listProviders } from "./providers.mjs";

const USER_CONFIG_DIR = path.join(".claude");
const USER_CONFIG_FILE = "ai-plugins-cc.json";
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_STALE_MS = 30_000;

export function defaultUserConfigPath(home = os.homedir()) {
  return path.join(home, USER_CONFIG_DIR, USER_CONFIG_FILE);
}

function lockFilePath(filePath) {
  return `${filePath}.lock`;
}

function tryAcquireLock(lockFile) {
  let fd;
  try {
    fd = fs.openSync(lockFile, "wx");
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function isStaleLock(lockFile) {
  let stat;
  try {
    stat = fs.statSync(lockFile);
  } catch {
    return true;
  }
  if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return true;
  }
  if (typeof meta?.pid !== "number") return true;
  if (meta.pid === process.pid) return false;
  try {
    process.kill(meta.pid, 0); // signal 0 → existence check
    return false;
  } catch (err) {
    return err.code === "ESRCH";
  }
}

function syncSleep(ms) {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) {}
}

function acquireLock(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockFile = lockFilePath(filePath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (tryAcquireLock(lockFile)) return lockFile;
    if (isStaleLock(lockFile)) {
      try { fs.unlinkSync(lockFile); } catch { /* raced with another waiter */ }
      continue;
    }
    syncSleep(LOCK_RETRY_DELAY_MS);
  }
  throw new Error(`Timed out acquiring settings lock at ${lockFile}`);
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
}

function withLock(filePath, fn) {
  const lockFile = acquireLock(filePath);
  try {
    return fn();
  } finally {
    releaseLock(lockFile);
  }
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
  return withLock(filePath, () => writeSettingsUnlocked(filePath, settings));
}

function writeSettingsUnlocked(filePath, settings) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = normalizeSettings(settings);
  const suffix = `${process.pid}.${randomBytes(4).toString("hex")}`;
  const tmp = `${filePath}.tmp.${suffix}`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
  return { filePath, settings: normalized };
}

function readSettingsUnlocked(filePath) {
  if (!fs.existsSync(filePath)) return defaultSettings();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeSettings(parsed);
  } catch {
    return defaultSettings();
  }
}

/**
 * Lock once around the read-modify-write for every settings mutation. Without
 * this, two concurrent /ai:settings invocations could each load the same
 * snapshot and one would silently overwrite the other.
 */
function mutateSettings(home, mutator) {
  const filePath = defaultUserConfigPath(home);
  return withLock(filePath, () => {
    const current = readSettingsUnlocked(filePath);
    const next = mutator(current);
    return writeSettingsUnlocked(filePath, next);
  });
}

export function enableProvider(id, home = os.homedir()) {
  assertKnownProvider(id);
  return mutateSettings(home, (current) => {
    const enabled = new Set(current.enabledProviders);
    enabled.add(id);
    return { ...current, enabledProviders: orderedList(enabled) };
  });
}

export function disableProvider(id, home = os.homedir()) {
  assertKnownProvider(id);
  return mutateSettings(home, (current) => {
    const enabled = new Set(current.enabledProviders);
    enabled.delete(id);
    const compare = current.compareProviders.filter((p) => p !== id);
    let provider = current.provider;
    if (provider === id) provider = orderedList(enabled)[0] ?? null;
    return {
      ...current,
      provider,
      enabledProviders: orderedList(enabled),
      compareProviders: compare
    };
  });
}

export function setDefaultProvider(id, home = os.homedir()) {
  assertKnownProvider(id);
  return mutateSettings(home, (current) => {
    const enabled = new Set(current.enabledProviders);
    enabled.add(id);
    return {
      ...current,
      provider: id,
      enabledProviders: orderedList(enabled)
    };
  });
}

export function setCompareProviders(ids, home = os.homedir()) {
  for (const id of ids) assertKnownProvider(id);
  return mutateSettings(home, (current) => ({
    ...current,
    compareProviders: [...ids]
  }));
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
