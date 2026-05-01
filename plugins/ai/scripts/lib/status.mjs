// Status + verify primitives for /ai:setup. Each helper probes one provider
// (or all of them) and returns a structured report the wizard can read.
//
// We don't reimplement provider probing — every provider plugin already ships
// a `setup --json` subcommand. We just aggregate.

import process from "node:process";

import { discoverCodexInstall, invokeCodexCommand } from "@ai-plugins-cc/codex-adapter";

import { dispatchToProvider } from "./dispatch.mjs";
import { listProviders, SiblingPluginMissingError } from "./providers.mjs";

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
  let result;
  try {
    result = await dispatchToProvider(
      providerId,
      ["setup", "--json"],
      {
        cwd: options.cwd ?? process.cwd(),
        env: options.env,
        timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS
      }
    );
  } catch (err) {
    // The umbrella resolves sibling companion paths lazily. If the user
    // installed only the umbrella plugin (without the matching provider
    // plugin), surface that distinctly from "the CLI binary is missing"
    // — otherwise /ai:setup would helpfully run `npm install -g <cli>` and
    // still leave the user with no working /ai:* dispatch.
    if (err instanceof SiblingPluginMissingError) {
      return {
        providerId,
        ready: false,
        available: false,
        loggedIn: false,
        pluginInstalled: false,
        detail:
          `Sibling plugin "${providerId}" is not installed. ` +
          `Run /plugin install ${providerId}@ai-plugins-cc to fix.`,
        raw: null
      };
    }
    throw err;
  }
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

async function probeCodex(options = {}) {
  // Codex is special: there's no local CLI binary; the "CLI" for our
  // purposes is the upstream openai/codex-plugin-cc install. Two layers
  // of check:
  //   1. Discovery — is upstream installed at all?
  //   2. If so, run upstream's own `setup --json` to get its real readiness
  //      signal (CLI version, auth, session runtime, …) instead of just
  //      sniffing env vars ourselves.

  let install;
  try {
    install = discoverCodexInstall();
  } catch {
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

  // Upstream is on disk — ask it to introspect itself. Same setup --json
  // contract every plugin in this family ships.
  let invocation;
  try {
    invocation = await invokeCodexCommand({
      args: ["setup", "--json"],
      install,
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS
    });
  } catch (err) {
    return {
      providerId: "codex",
      ready: false,
      available: true,
      installed: true,
      loggedIn: false,
      detail: `Could not invoke upstream codex setup: ${err?.message ?? err}`,
      raw: { install: snapshotInstall(install) }
    };
  }

  if (invocation.status !== 0) {
    return {
      providerId: "codex",
      ready: false,
      available: true,
      installed: true,
      loggedIn: false,
      detail: `Upstream codex setup exited ${invocation.status}: ${truncate(invocation.stderr, 240)}`,
      raw: { install: snapshotInstall(install), invocationStderr: invocation.stderr }
    };
  }

  let raw = null;
  try {
    raw = JSON.parse(invocation.stdout);
  } catch (err) {
    return {
      providerId: "codex",
      ready: false,
      available: true,
      installed: true,
      loggedIn: false,
      detail: `Upstream codex setup --json was not valid JSON: ${err.message}`,
      raw: { install: snapshotInstall(install), stdoutPreview: truncate(invocation.stdout, 240) }
    };
  }

  const cliBlock = raw.codex ?? raw.cli ?? null;
  const auth = raw.auth ?? null;
  return {
    providerId: "codex",
    ready: Boolean(raw.ready),
    available: Boolean(cliBlock?.available ?? true),
    installed: true,
    loggedIn: Boolean(auth?.loggedIn ?? false),
    detail: summarizeProbe({ available: cliBlock?.available ?? true, loggedIn: auth?.loggedIn, ready: raw.ready }),
    raw: { install: snapshotInstall(install), upstream: raw }
  };
}

function snapshotInstall(install) {
  return { root: install.root, version: install.version, source: install.source };
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
