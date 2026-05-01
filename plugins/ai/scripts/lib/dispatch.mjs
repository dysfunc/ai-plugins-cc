import { spawn } from "node:child_process";
import process from "node:process";

import { getProvider } from "./providers.mjs";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STDOUT_CAP = 50 * 1024 * 1024;
const DEFAULT_STDERR_CAP = 10 * 1024 * 1024;

/**
 * Send `signal` to the process group `child` belongs to, falling back to
 * killing only `child` if the group send fails (which happens on platforms
 * where the child wasn't spawned with `detached: true`, or when the group
 * already exited). Mirrors the trick `npm`, `pnpm`, `lerna` and friends use
 * to clean up subtrees.
 */
function killProcessTree(child, signal = "SIGKILL") {
  if (!child || typeof child.pid !== "number") return;
  try {
    // Negative pid → the whole process group (when spawned detached).
    process.kill(-child.pid, signal);
    return;
  } catch {
    // group send failed — fall through to direct kill
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

// Union of every value-taking option the provider companions accept across
// their subcommands (review/adversarial-review/task/status/result/cancel/
// task-worker/setup). Without this set, "focus text" detection would
// misclassify the value half of `--scope diff` as a positional argument
// and silently route /ai:review to adversarial-review — see the codex+gemini
// review consensus on this regression.
const VALUE_OPTION_LONG_KEYS = new Set([
  "base",
  "scope",
  "model",
  "cwd",
  "prompt-file",
  "dirs",
  "files",
  "max-files",
  "max-file-bytes",
  "timeout-ms",
  "poll-interval-ms",
  "job-id"
]);

// Short-form aliases used by the same set of companions (`-m` → `--model`,
// `-C` → `--cwd`). Anything not listed is treated as a boolean short flag.
const SHORT_OPTION_ALIASES = new Map([
  ["m", "model"],
  ["C", "cwd"]
]);

/**
 * Walk a passthrough argv and return true iff there is at least one true
 * positional argument (i.e. focus text). Skips the values of known value-
 * taking options so `--scope diff` and `-m flash` don't get misread as
 * positionals.
 */
function hasPositionalFocusText(args) {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (typeof token !== "string") continue;
    if (token === "--") {
      // Everything after `--` is a positional; if any exists, that's focus text.
      return i + 1 < args.length;
    }
    if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split("=", 2);
      if (inlineValue === undefined && VALUE_OPTION_LONG_KEYS.has(key)) {
        i += 1; // skip the value half (lives in the next token)
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const shortKey = token.slice(1);
      const longKey = SHORT_OPTION_ALIASES.get(shortKey) ?? shortKey;
      if (VALUE_OPTION_LONG_KEYS.has(longKey)) {
        i += 1;
      }
      continue;
    }
    return true;
  }
  return false;
}

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
  if (command === "review") {
    return [hasPositionalFocusText(args) ? "adversarial-review" : "review", ...args];
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
 * Build a streaming sink that splits incoming stderr chunks on newlines and
 * writes each line to `dest`, prefixed with `prefix`. Companions emit live
 * progress to stderr — piping it through gives the user mid-flight feedback
 * during long-running compares instead of a blank screen for ~10 minutes.
 */
export function makeStderrLineStreamer(prefix, dest = process.stderr) {
  let buf = "";
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length > 0) dest.write(`${prefix}${line}\n`);
    }
  };
}

/**
 * Dispatch a command (review/rescue/gater plus its arguments) to a single
 * provider. Returns a uniform shape regardless of whether the provider is
 * an in-house companion subprocess or the codex-adapter:
 *
 *   { providerId, status, stdout, stderr, signal, error, timedOut }
 *
 * Pass `options.onStderrChunk(chunk)` to stream the child's stderr live as
 * each buffer arrives. Captured stderr is still returned in the result.
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
      stdin: options.stdin,
      onStderr: options.onStderrChunk
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
  const stdoutCap = options.stdoutCapBytes ?? DEFAULT_STDOUT_CAP;
  const stderrCap = options.stderrCapBytes ?? DEFAULT_STDERR_CAP;
  const args = Array.isArray(providerArgs) ? providerArgs : [];
  const env = { ...process.env, ...(options.env ?? {}) };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [provider.companionPath, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env,
      // `detached: true` makes the child a process group leader so we can
      // kill the whole tree on timeout/cap-overrun. stdio stays piped to
      // the parent so capture still works.
      detached: true,
      stdio: [options.stdin == null ? "ignore" : "pipe", "pipe", "pipe"]
    });

    if (options.stdin != null) {
      child.stdin.end(options.stdin);
    }

    let stdout = "";
    let stderr = "";
    let stdoutOverrun = false;
    let stderrOverrun = false;
    const onStderrChunk = typeof options.onStderrChunk === "function" ? options.onStderrChunk : null;

    child.stdout.on("data", (chunk) => {
      if (stdoutOverrun) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > stdoutCap) {
        stdoutOverrun = true;
        killProcessTree(child);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (!stderrOverrun) {
        stderr += chunk.toString("utf8");
        if (stderr.length > stderrCap) {
          stderrOverrun = true;
          killProcessTree(child);
        }
      }
      // Pass the chunk through even after cap so live progress keeps flowing
      // to the user — only the captured copy is bounded.
      if (onStderrChunk) onStderrChunk(chunk);
    });

    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
    }

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      let status;
      if (timedOut) status = 124;
      else if (stdoutOverrun || stderrOverrun) status = 137;
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
        stdoutOverrun
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
        stdoutOverrun
      });
    });
  });
}

/**
 * Fan out the same command to multiple providers in parallel. Each provider
 * runs independently; one failure does not abort the others. Returns a list
 * of dispatch results in the same order as providerIds.
 *
 * Pass `options.onStderrChunkFor(providerId) → onStderrChunk` to stream each
 * provider's stderr live, with caller-controlled per-provider prefixing.
 */
export async function dispatchCompare(providerIds, providerArgs, options = {}) {
  const onStderrChunkFor = typeof options.onStderrChunkFor === "function" ? options.onStderrChunkFor : null;
  const settled = await Promise.allSettled(
    providerIds.map((id) => {
      const perProviderOptions = onStderrChunkFor
        ? { ...options, onStderrChunk: onStderrChunkFor(id) }
        : options;
      return dispatchToProvider(id, providerArgs, perProviderOptions);
    })
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
