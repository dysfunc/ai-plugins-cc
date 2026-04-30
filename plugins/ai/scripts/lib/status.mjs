// Status + verify primitives for /ai:setup. Each helper probes one provider
// (or all of them) and returns a structured report the wizard can read.
//
// We don't reimplement provider probing — every provider plugin already ships
// a `setup --json` subcommand. We just aggregate.

import process from "node:process";

import { discoverCodexInstall } from "@ai-plugins-cc/codex-adapter";

import { dispatchToProvider } from "./dispatch.mjs";
import { listProviders } from "./providers.mjs";

const PROBE_TIMEOUT_MS = 30_000;

/**
 * Run a single provider's `setup --json` (or, for codex, probe the upstream
 * install + run upstream's setup if installed). Returns:
 *   {
 *     providerId,
 *     ready,          // every check passed
 *     available,      // CLI/upstream is installed and on PATH
 *     loggedIn,       // auth is configured
 *     installed,      // (codex only) upstream codex-plugin-cc is present
 *     detail,         // human-readable summary
 *     raw             // full JSON from the underlying setup probe, when available
 *   }
 */
export async function probeProvider(providerId, options = {}) {
  if (providerId === "codex") return probeCodex(options);
  return probeInHouseProvider(providerId, options);
}

/**
 * Probe every registered provider in parallel.
 */
export async function probeAllProviders(options = {}) {
  const ids = listProviders();
  const results = await Promise.allSettled(
    ids.map((id) => probeProvider(id, options))
  );
  const out = {};
  results.forEach((entry, i) => {
    const id = ids[i];
    if (entry.status === "fulfilled") out[id] = entry.value;
    else
      out[id] = {
        providerId: id,
        ready: false,
        available: false,
        loggedIn: false,
        detail: `probe threw: ${entry.reason?.message ?? entry.reason}`
      };
  });
  return out;
}

async function probeInHouseProvider(providerId, options) {
  const result = await dispatchToProvider(
    providerId,
    ["setup", "--json"],
    {
      cwd: options.cwd ?? process.cwd(),
      env: options.env,
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS
    }
  );
  if (result.status !== 0) {
    return {
      providerId,
      ready: false,
      available: false,
      loggedIn: false,
      detail: `setup --json failed: exit=${result.status} ${truncate(result.stderr, 240)}`,
      raw: null
    };
  }
  let raw = null;
  try {
    raw = JSON.parse(result.stdout);
  } catch (err) {
    return {
      providerId,
      ready: false,
      available: false,
      loggedIn: false,
      detail: `setup --json output was not valid JSON: ${err.message}`,
      raw: null
    };
  }
  const cliBlock = raw[providerId] ?? raw.cli ?? null;
  const auth = raw.auth ?? null;
  return {
    providerId,
    ready: Boolean(raw.ready),
    available: Boolean(cliBlock?.available ?? false),
    loggedIn: Boolean(auth?.loggedIn ?? false),
    detail: summarizeProbe({ available: cliBlock?.available, loggedIn: auth?.loggedIn, ready: raw.ready }),
    raw
  };
}

async function probeCodex(_options) {
  // Codex is special: the "CLI" for our purposes is the upstream
  // codex-plugin-cc install, not a local binary. We don't attempt to invoke
  // the upstream companion here — that needs network for first install. We
  // just report whether discovery succeeds, and let the wizard drive the
  // install separately via /ai:codex-update.
  let install;
  try {
    install = discoverCodexInstall();
  } catch (err) {
    return {
      providerId: "codex",
      ready: false,
      available: false,
      installed: false,
      loggedIn: false,
      detail: "Upstream openai/codex-plugin-cc is not installed. Run /ai:codex-update.",
      raw: null
    };
  }
  // Upstream is installed; auth state depends on env vars the user controls.
  const env = process.env;
  const hasAuth = Boolean(env.OPENAI_API_KEY || env.CODEX_API_KEY);
  return {
    providerId: "codex",
    ready: hasAuth,
    available: true,
    installed: true,
    loggedIn: hasAuth,
    detail: hasAuth
      ? `Upstream codex installed at ${install.root} (version ${install.version ?? "unknown"}).`
      : "Upstream codex is installed but no OPENAI_API_KEY (or CODEX_API_KEY) is set.",
    raw: { install: { root: install.root, version: install.version, source: install.source } }
  };
}

function summarizeProbe({ available, loggedIn, ready }) {
  if (ready) return "ready";
  if (!available) return "CLI not on PATH";
  if (!loggedIn) return "no auth credential detected";
  return "needs attention";
}

function truncate(text, limit) {
  const s = String(text ?? "").trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
