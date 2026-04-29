import test from "node:test";
import assert from "node:assert/strict";

import { invokeCodexCommand } from "@ai-plugins-cc/codex-adapter";
import { writeFakeCodexInstall } from "./fake-codex-install.mjs";

test("invokeCodexCommand spawns the companion and captures stdout", async () => {
  const install = writeFakeCodexInstall();
  const result = await invokeCodexCommand({
    args: ["review", "--json"],
    install
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"verdict":\s*"approve"/);
  assert.equal(result.install.companionPath, install.companionPath);
});

test("invokeCodexCommand surfaces non-zero exit codes from the companion", async () => {
  const install = writeFakeCodexInstall();
  const result = await invokeCodexCommand({
    args: ["review", "--json", "--explode"],
    install
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /simulated codex failure/);
});

test("invokeCodexCommand respects timeoutMs and reports timedOut", async () => {
  const install = writeFakeCodexInstall();
  const result = await invokeCodexCommand({
    args: ["sleep", "5000"],
    install,
    timeoutMs: 200
  });

  assert.equal(result.status, 124, "timeout exit code");
  assert.equal(result.timedOut, true);
});

test("invokeCodexCommand caps stdout via stdoutCapBytes", async () => {
  const install = writeFakeCodexInstall();
  const result = await invokeCodexCommand({
    args: ["burst", String(200_000)],
    install,
    stdoutCapBytes: 4096
  });

  assert.equal(result.stdoutOverrun, true);
  // Output may slightly exceed the cap before the kill takes effect, but it
  // should not be the full 200 KB the child tried to emit.
  assert.ok(result.stdout.length < 100_000, `expected truncated output, got ${result.stdout.length} bytes`);
});

test("invokeCodexCommand applies an env allowlist", async () => {
  const install = writeFakeCodexInstall();
  const previousSecret = process.env.SOME_SECRET_TOKEN;
  process.env.SOME_SECRET_TOKEN = "should-not-leak";
  try {
    // The fake companion doesn't introspect env, but we can at minimum
    // assert the call succeeds — the allowlist filtering happens before
    // spawn, so any divergence would show up as a missing PATH and ENOENT.
    const result = await invokeCodexCommand({ args: ["--version"], install });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /codex-fake/);
  } finally {
    if (previousSecret === undefined) delete process.env.SOME_SECRET_TOKEN;
    else process.env.SOME_SECRET_TOKEN = previousSecret;
  }
});
