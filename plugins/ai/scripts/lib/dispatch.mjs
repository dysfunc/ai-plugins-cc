import { spawn } from "node:child_process";
import process from "node:process";

import { getProvider } from "./providers.mjs";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Translate an umbrella command (review/rescue/gater) into the actual
 * companion subcommand. Every provider companion (gemini, grok, upstream
 * codex) ships the same surface — `review`, `adversarial-review`, `task`,
 * `setup`, etc. — but never `rescue` or `gater`. The umbrella accepts
 * those names as user-facing verbs and rewrites them here.
 *
 *   review  + no focus  → review               (built-in diff reviewer)
 *   review  + focus     → adversarial-review   (focus-aware reviewer)
 *   rescue              → task                 (delegated investigation)
 *   gater               → adversarial-review   (stop-gate reviewer)
 *
 * Anything else is forwarded unchanged so `setup --json`, `verify`, and
 * provider-native subcommands (e.g. `task`, `status`) still work.
 */
export function mapUmbrellaCommandToProviderArgs(command, passthrough = []) {
  const args = Array.isArray(passthrough) ? [...passthrough] : [];
  const hasFocusText = args.some((a) => typeof a === "string" && !a.startsWith("--"));
  if (command === "review") {
    return [hasFocusText ? "adversarial-review" : "review", ...args];
  }
  if (command === "rescue") return ["task", ...args];
  if (command === "gater") return ["adversarial-review", ...args];
  return [command, ...args];
}

function defaultEnvForProvider(providerId) {
  // Gemini's CLI refuses to run in a workspace it has not previously
  // "trusted" unless GEMINI_CLI_TRUST_WORKSPACE=true is set. Headless
  // dispatch from /ai:* commands always has a fresh subprocess env, so
  // we opt in by default. Callers can override via options.env.
  if (providerId === "gemini") return { GEMINI_CLI_TRUST_WORKSPACE: "true" };
  return {};
}

/**
 * Dispatch a command (review/rescue/gater plus its arguments) to a single
 * provider. Returns a uniform shape regardless of whether the provider is
 * an in-house companion subprocess or the codex-adapter:
 *
 *   { providerId, status, stdout, stderr, signal, error, timedOut }
 */
export async function dispatchToProvider(providerId, providerArgs, options = {}) {
  const provider = getProvider(providerId);
  const mergedEnv = { ...defaultEnvForProvider(providerId), ...(options.env ?? {}) };
  if (provider.kind === "external") {
    const result = await provider.invoke({
      args: providerArgs,
      cwd: options.cwd,
      env: mergedEnv,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdoutCapBytes: options.stdoutCapBytes,
      stdin: options.stdin
    });
    return {
      providerId,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal,
      error: result.error,
      timedOut: result.timedOut === true,
      stdoutOverrun: result.stdoutOverrun === true
    };
  }

  // In-house: subprocess the provider's companion script directly.
  return spawnInHouseCompanion(
    { id: provider.id, companionPath: provider.companionPath },
    providerArgs,
    { ...options, env: mergedEnv }
  );
}

/**
 * Spawn an in-house provider's companion script directly. Exposed for tests
 * that want to exercise the umbrella's spawn behavior without going through
 * the full registry — pass a custom { id, companionPath } pair pointing at
 * a fake script.
 */
export function spawnInHouseCompanion(provider, providerArgs, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = Array.isArray(providerArgs) ? providerArgs : [];
  const env = { ...process.env, ...(options.env ?? {}) };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [provider.companionPath, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env,
      stdio: [options.stdin == null ? "ignore" : "pipe", "pipe", "pipe"]
    });

    if (options.stdin != null) {
      child.stdin.end(options.stdin);
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch (_) { /* already gone */ }
      }, timeoutMs);
    }

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      let status;
      if (timedOut) status = 124;
      else if (code === 0) status = 0;
      else status = code ?? 1;
      resolve({
        providerId: provider.id,
        status,
        stdout,
        stderr,
        signal: signal ?? null,
        error: null,
        timedOut,
        stdoutOverrun: false
      });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        providerId: provider.id,
        status: 1,
        stdout,
        stderr,
        signal: null,
        error: String(err),
        timedOut,
        stdoutOverrun: false
      });
    });
  });
}

/**
 * Fan out the same command to multiple providers in parallel. Each provider
 * runs independently; one failure does not abort the others. Returns a list
 * of dispatch results in the same order as providerIds.
 */
export async function dispatchCompare(providerIds, providerArgs, options = {}) {
  const settled = await Promise.allSettled(
    providerIds.map((id) => dispatchToProvider(id, providerArgs, options))
  );
  return settled.map((entry, index) => {
    if (entry.status === "fulfilled") return entry.value;
    return {
      providerId: providerIds[index],
      status: 1,
      stdout: "",
      stderr: "",
      signal: null,
      error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
      timedOut: false,
      stdoutOverrun: false
    };
  });
}
