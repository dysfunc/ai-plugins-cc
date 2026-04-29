import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { fakeGrokEnv, writeFakeGrokBinary } from "./fake-grok-fixture.mjs";
import {
  getGrokAvailability,
  getGrokAuthStatus,
  parseStructuredOutput,
  runGrokTurn
} from "../scripts/lib/grok.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "scripts", "grok-companion.mjs");
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function withFakeEnv() {
  const { dir } = writeFakeGrokBinary();
  const env = { ...process.env, ...fakeGrokEnv(dir) };
  return { env, fakeDir: dir };
}

test("getGrokAvailability detects the fake grok binary", () => {
  const { fakeDir, env } = withFakeEnv();
  const previousPath = process.env.PATH;
  const previousBin = process.env.GROK_BIN;
  process.env.PATH = env.PATH;
  process.env.GROK_BIN = env.GROK_BIN;
  try {
    const status = getGrokAvailability(fakeDir);
    assert.equal(status.available, true);
    assert.match(status.detail, /grok-fake/);
  } finally {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.GROK_BIN; else process.env.GROK_BIN = previousBin;
  }
});

test("getGrokAuthStatus reports api-key auth when GROK_API_KEY is set", async () => {
  const { fakeDir, env } = withFakeEnv();
  const previousBin = process.env.GROK_BIN;
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  process.env.GROK_BIN = "grok";
  try {
    const status = await getGrokAuthStatus(fakeDir, {
      env: { GROK_API_KEY: "test", PATH: env.PATH }
    });
    assert.equal(status.loggedIn, true);
    assert.equal(status.authMethod, "api-key");
  } finally {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.GROK_BIN; else process.env.GROK_BIN = previousBin;
  }
});

test("getGrokAuthStatus reports logged-out when no credentials are set", async () => {
  const { fakeDir } = withFakeEnv();
  const previousBin = process.env.GROK_BIN;
  const previousPath = process.env.PATH;
  process.env.GROK_BIN = "grok";
  process.env.PATH = `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`;
  try {
    const status = await getGrokAuthStatus(fakeDir, {
      env: { PATH: process.env.PATH }
    });
    assert.equal(status.loggedIn, false);
    assert.match(status.detail, /no grok auth credential detected/i);
  } finally {
    if (previousBin === undefined) delete process.env.GROK_BIN; else process.env.GROK_BIN = previousBin;
    process.env.PATH = previousPath;
  }
});

test("parseStructuredOutput extracts fenced JSON blocks", () => {
  const result = parseStructuredOutput("Here is the review:\n```json\n{\"verdict\":\"approve\",\"summary\":\"ok\",\"findings\":[],\"next_steps\":[]}\n```");
  assert.equal(result.parseError, null);
  assert.equal(result.parsed.verdict, "approve");
});

test("parseStructuredOutput falls back to raw JSON.parse", () => {
  const result = parseStructuredOutput("{\"verdict\":\"approve\",\"summary\":\"ok\",\"findings\":[],\"next_steps\":[]}");
  assert.equal(result.parseError, null);
  assert.equal(result.parsed.summary, "ok");
});

test("parseStructuredOutput surfaces parse errors with raw output preserved", () => {
  const result = parseStructuredOutput("not json at all");
  assert.equal(result.parsed, null);
  assert.equal(result.rawOutput, "not json at all");
  assert.ok(result.parseError);
});

test("runGrokTurn captures stdout and writes a transcript turn", async () => {
  const { env, fakeDir } = withFakeEnv();
  const tmp = makeTempDir();
  const transcriptPath = path.join(tmp, "transcript.md");
  const previousBin = process.env.GROK_BIN;
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  process.env.GROK_BIN = "grok";
  try {
    const result = await runGrokTurn(fakeDir, {
      prompt: "ECHO:hello-from-fake",
      transcriptPath
    });
    assert.equal(result.status, 0);
    assert.equal(result.finalMessage, "hello-from-fake");
    assert.equal(fs.existsSync(transcriptPath), true);
    const transcript = fs.readFileSync(transcriptPath, "utf8");
    assert.match(transcript, /## Turn 1/);
    assert.match(transcript, /Assistant: hello-from-fake/);
  } finally {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.GROK_BIN; else process.env.GROK_BIN = previousBin;
  }
});

test("runGrokTurn prepends a prior transcript when resuming", async () => {
  const { env, fakeDir } = withFakeEnv();
  const tmp = makeTempDir();
  const priorPath = path.join(tmp, "prior.md");
  fs.writeFileSync(priorPath, "## Turn 1\nUser: prior question\n\nAssistant: prior answer\n\n", "utf8");
  const transcriptPath = path.join(tmp, "next.md");
  const previousBin = process.env.GROK_BIN;
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  process.env.GROK_BIN = "grok";
  try {
    const result = await runGrokTurn(fakeDir, {
      prompt: "ECHO:resumed",
      transcriptPath,
      resumeTranscriptPath: priorPath
    });
    assert.equal(result.status, 0);
    assert.equal(result.finalMessage, "resumed");
    assert.equal(result.transcriptTruncated, false);
  } finally {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.GROK_BIN; else process.env.GROK_BIN = previousBin;
  }
});

test("runGrokTurn flags transcript truncation when prior transcript exceeds the cap", async () => {
  const { env, fakeDir } = withFakeEnv();
  const tmp = makeTempDir();
  const priorPath = path.join(tmp, "prior.md");
  const blocks = Array.from({ length: 20 }, (_, i) =>
    `## Turn ${i + 1}\nUser: question ${i}\n\nAssistant: answer ${i}\n\n`
  ).join("");
  fs.writeFileSync(priorPath, blocks, "utf8");
  const transcriptPath = path.join(tmp, "next.md");
  const previousBin = process.env.GROK_BIN;
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  process.env.GROK_BIN = "grok";
  try {
    const result = await runGrokTurn(fakeDir, {
      prompt: "ECHO:ok",
      transcriptPath,
      resumeTranscriptPath: priorPath
    });
    assert.equal(result.status, 0);
    assert.equal(result.transcriptTruncated, true);
  } finally {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.GROK_BIN; else process.env.GROK_BIN = previousBin;
  }
});

test("runGrokTurn surfaces signal-cancelled exits with status != 0", async () => {
  const { env, fakeDir } = withFakeEnv();
  const tmp = makeTempDir();
  const transcriptPath = path.join(tmp, "transcript.md");
  const controller = new AbortController();
  const previousBin = process.env.GROK_BIN;
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  process.env.GROK_BIN = "grok";
  try {
    const promise = runGrokTurn(fakeDir, {
      prompt: "SLEEP:30",
      transcriptPath,
      abortSignal: controller.signal
    });
    setTimeout(() => controller.abort(), 100).unref?.();
    const result = await promise;
    assert.notEqual(result.status, 0, "cancelled run must not be reported as success");
    assert.equal(fs.existsSync(transcriptPath), false, "no transcript turn appended on cancel");
  } finally {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.GROK_BIN; else process.env.GROK_BIN = previousBin;
  }
});

test("companion task subcommand returns echoed prompt as final answer", () => {
  const { env, fakeDir } = withFakeEnv();
  const workspace = makeTempDir();
  initGitRepo(workspace);
  fs.writeFileSync(path.join(workspace, "README.md"), "x\n");
  run("git", ["add", "README.md"], { cwd: workspace });
  run("git", ["commit", "-m", "init"], { cwd: workspace });

  const pluginData = makeTempDir();
  const result = run(
    process.execPath,
    [COMPANION, "task", "ECHO:companion-says-hi"],
    {
      cwd: workspace,
      env: { ...env, [PLUGIN_DATA_ENV]: pluginData }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /companion-says-hi/);
});

test("companion task --print-command includes context inventory without invoking grok or creating a job", () => {
  const { env } = withFakeEnv();
  const workspace = makeTempDir();
  fs.writeFileSync(path.join(workspace, "notes.txt"), "context\n", "utf8");
  const pluginData = makeTempDir();
  const invocationLog = path.join(makeTempDir(), "grok-invocations.log");

  const result = run(
    process.execPath,
    [COMPANION, "task", "--dirs", ".", "--print-command", "describe this"],
    {
      cwd: workspace,
      env: { ...env, [PLUGIN_DATA_ENV]: pluginData, FAKE_GROK_INVOCATION_LOG: invocationLog }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Assembled prompt bytes:/);
  assert.match(result.stdout, /notes\.txt \(\d+ bytes\)/);
  assert.doesNotMatch(result.stdout, /task-[a-z0-9]+/);
  assert.equal(fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8") : "", "");
});

test("companion setup --json reports ready when fake grok and key are present", () => {
  const { env } = withFakeEnv();
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const pluginData = makeTempDir();
  const result = run(
    process.execPath,
    [COMPANION, "setup", "--json"],
    {
      cwd: workspace,
      env: { ...env, [PLUGIN_DATA_ENV]: pluginData }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.grok.available, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("companion setup --json reports needs-attention when no auth is set", () => {
  const { fakeDir } = withFakeEnv();
  const env = { ...process.env, PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`, GROK_BIN: "grok" };
  delete env.GROK_API_KEY;
  delete env.XAI_API_KEY;
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const pluginData = makeTempDir();
  const result = run(
    process.execPath,
    [COMPANION, "setup", "--json"],
    {
      cwd: workspace,
      env: { ...env, [PLUGIN_DATA_ENV]: pluginData }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.grok.available, true);
  assert.equal(payload.auth.loggedIn, false);
});

function withFakePath(env, fn) {
  // getGrokAvailability calls binaryAvailable() which uses process.env, not
  // options.env. To keep these turn-level tests hermetic on machines without
  // a real grok binary on PATH, point process.env at the fake for the call
  // and restore on exit.
  const previousPath = process.env.PATH;
  const previousBin = process.env.GROK_BIN;
  process.env.PATH = env.PATH;
  process.env.GROK_BIN = env.GROK_BIN;
  return Promise.resolve(fn()).finally(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.GROK_BIN;
    else process.env.GROK_BIN = previousBin;
  });
}

test("runGrokTurn captures the full output even with a large final write", async () => {
  const { env } = withFakeEnv();
  const workspace = makeTempDir();
  const transcriptPath = path.join(workspace, "t.json");
  const payload = "X".repeat(64 * 1024);
  await withFakePath(env, async () => {
    const result = await runGrokTurn(workspace, {
      prompt: `ECHO:${payload}`,
      transcriptPath,
      env
    });
    assert.equal(result.status, 0, result.error ?? result.stderr);
    assert.equal(
      result.finalMessage.length,
      payload.length,
      `expected ${payload.length} bytes captured, got ${result.finalMessage.length}`
    );
  });
});

test("runGrokTurn invokes onChildPid with the spawned child's PID, not the caller's", async () => {
  const { env, fakeDir } = withFakeEnv();
  const workspace = makeTempDir();
  const transcriptPath = path.join(workspace, "transcript.json");

  const captured = [];
  await withFakePath(env, async () => {
    const result = await runGrokTurn(workspace, {
      prompt: "ECHO:hello-world",
      transcriptPath,
      env,
      onChildPid: (pid) => captured.push(pid)
    });

    assert.equal(result.status, 0, "fake grok should exit cleanly");
    assert.equal(captured.length, 1, "onChildPid must fire exactly once per turn");
    const [pid] = captured;
    assert.equal(typeof pid, "number");
    assert.notEqual(pid, process.pid, "captured PID must be the child's, not the test runner's");
    assert.notEqual(pid, fakeDir, "sanity: pid is a number, not a path");
  });
});

test("companion task-resume-candidate reports no candidate on a fresh workspace", () => {
  const { env } = withFakeEnv();
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const pluginData = makeTempDir();
  const result = run(
    process.execPath,
    [COMPANION, "task-resume-candidate", "--json"],
    {
      cwd: workspace,
      env: { ...env, [PLUGIN_DATA_ENV]: pluginData }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, false);
  assert.equal(payload.candidate, null);
});
