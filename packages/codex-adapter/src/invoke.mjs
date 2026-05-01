import { spawn } from "node:child_process";
import process from "node:process";

import { discoverCodexInstall } from "./discover.mjs";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STDOUT_CAP = 50 * 1024 * 1024;

const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "AI_PLUGINS_CC_SESSION_ID"
];

function filteredEnv(extra = {}) {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return { ...out, ...extra };
}

/**
 * Spawn upstream codex-companion.mjs as a subprocess. Returns
 *   { status, stdout, stderr, signal, install }
 *
 * options:
 *   - args:        string[] (e.g. ["review", "--json", "--scope", "diff"])
 *   - cwd:         working directory for the subprocess
 *   - env:         extra env entries (merged on top of the allowlist)
 *   - timeoutMs:   defaults to 10 minutes
 *   - stdoutCapBytes: kill the process if stdout exceeds this (default 50MB)
 *   - stdin:       optional string to pipe to the child
 *   - install:     pre-resolved discoverCodexInstall() result; if absent, discover
 *   - onStderr:    optional fn(chunk) called for each stderr buffer; useful for
 *                  streaming progress to the parent. Captured stderr is still
 *                  returned in the result regardless.
 */
export async function invokeCodexCommand(options = {}) {
  const install = options.install ?? discoverCodexInstall(options.discover ?? {});
  const args = Array.isArray(options.args) ? options.args : [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = options.stdoutCapBytes ?? DEFAULT_STDOUT_CAP;

  const child = spawn(process.execPath, [install.companionPath, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: filteredEnv(options.env),
    stdio: [options.stdin == null ? "ignore" : "pipe", "pipe", "pipe"]
  });

  if (options.stdin != null) {
    child.stdin.end(options.stdin);
  }

  let stdout = "";
  let stderr = "";
  let stdoutOverrun = false;
  child.stdout.on("data", (chunk) => {
    if (stdoutOverrun) return;
    stdout += chunk.toString("utf8");
    if (stdout.length > cap) {
      stdoutOverrun = true;
      try { child.kill("SIGKILL"); } catch (_) { /* already gone */ }
    }
  });
  const onStderr = typeof options.onStderr === "function" ? options.onStderr : null;
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (onStderr) onStderr(chunk);
  });

  let timedOut = false;
  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch (_) { /* already gone */ }
    }, timeoutMs);
  }

  // Resolve on 'close' so stdio buffers are fully drained before we read them.
  const exit = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", (err) => resolve({ code: 1, signal: null, error: err }));
  });
  if (timer) clearTimeout(timer);

  let status;
  if (timedOut) status = 124;
  else if (stdoutOverrun) status = 137;
  else if (exit.code === 0 && !exit.error) status = 0;
  else status = 1;

  return {
    status,
    stdout,
    stderr,
    signal: exit.signal ?? null,
    install,
    timedOut,
    stdoutOverrun,
    error: exit.error ? String(exit.error) : null
  };
}
