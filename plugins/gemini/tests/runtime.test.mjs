import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { fakeGeminiEnv, writeFakeGeminiBinary } from "./fake-gemini-fixture.mjs";
import {
  getGeminiAvailability,
  getGeminiAuthStatus,
  parseStructuredOutput,
  runGeminiTurn
} from "@ai-plugins-cc/core/gemini";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "scripts", "gemini-companion.mjs");
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function withFakeEnv() {
  const { dir } = writeFakeGeminiBinary();
  const env = { ...process.env, ...fakeGeminiEnv(dir) };
  return { env, fakeDir: dir };
}

test("getGeminiAvailability detects the fake gemini binary", () => {
  const { fakeDir, env } = withFakeEnv();
  const previousPath = process.env.PATH;
  const previousBin = process.env.GEMINI_BIN;
  process.env.PATH = env.PATH;
  process.env.GEMINI_BIN = env.GEMINI_BIN;
  try {
    const status = getGeminiAvailability(fakeDir);
    assert.equal(status.available, true);
    assert.match(status.detail, /gemini-fake/);
  } finally {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.GEMINI_BIN; else process.env.GEMINI_BIN = previousBin;
  }
});

test("getGeminiAuthStatus reports api-key auth when GEMINI_API_KEY is set", async () => {
  const { fakeDir, env } = withFakeEnv();
  const previousBin = process.env.GEMINI_BIN;
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  process.env.GEMINI_BIN = "gemini";
  try {
    const status = await getGeminiAuthStatus(fakeDir, {
      env: { GEMINI_API_KEY: "test", PATH: env.PATH }
    });
    assert.equal(status.loggedIn, true);
    assert.equal(status.authMethod, "api-key");
  } finally {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.GEMINI_BIN; else process.env.GEMINI_BIN = previousBin;
  }
});

test("getGeminiAuthStatus reports logged-out when no credentials are set", async () => {
  const { fakeDir } = withFakeEnv();
  const previousBin = process.env.GEMINI_BIN;
  const previousPath = process.env.PATH;
  process.env.GEMINI_BIN = "gemini";
  process.env.PATH = `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`;
  try {
    const status = await getGeminiAuthStatus(fakeDir, {
      env: { PATH: process.env.PATH }
    });
    assert.equal(status.loggedIn, false);
    assert.match(status.detail, /no gemini auth credential detected/i);
  } finally {
    if (previousBin === undefined) delete process.env.GEMINI_BIN; else process.env.GEMINI_BIN = previousBin;
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

test("runGeminiTurn captures stdout and writes a transcript turn", async () => {
  const { env, fakeDir } = withFakeEnv();
  const tmp = makeTempDir();
  const transcriptPath = path.join(tmp, "transcript.md");
  const previousBin = process.env.GEMINI_BIN;
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  process.env.GEMINI_BIN = "gemini";
  try {
    const result = await runGeminiTurn(fakeDir, {
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
    if (previousBin === undefined) delete process.env.GEMINI_BIN; else process.env.GEMINI_BIN = previousBin;
  }
});

test("runGeminiTurn prepends a prior transcript when resuming", async () => {
  const { env, fakeDir } = withFakeEnv();
  const tmp = makeTempDir();
  const priorPath = path.join(tmp, "prior.md");
  fs.writeFileSync(priorPath, "## Turn 1\nUser: prior question\n\nAssistant: prior answer\n\n", "utf8");
  const transcriptPath = path.join(tmp, "next.md");
  const previousBin = process.env.GEMINI_BIN;
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  process.env.GEMINI_BIN = "gemini";
  try {
    const result = await runGeminiTurn(fakeDir, {
      prompt: "ECHO:resumed",
      transcriptPath,
      resumeTranscriptPath: priorPath
    });
    assert.equal(result.status, 0);
    assert.equal(result.finalMessage, "resumed");
    assert.equal(result.transcriptTruncated, false);
  } finally {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.GEMINI_BIN; else process.env.GEMINI_BIN = previousBin;
  }
});

test("runGeminiTurn flags transcript truncation when prior transcript exceeds the cap", async () => {
  const { env, fakeDir } = withFakeEnv();
  const tmp = makeTempDir();
  const priorPath = path.join(tmp, "prior.md");
  const blocks = Array.from({ length: 20 }, (_, i) =>
    `## Turn ${i + 1}\nUser: question ${i}\n\nAssistant: answer ${i}\n\n`
  ).join("");
  fs.writeFileSync(priorPath, blocks, "utf8");
  const transcriptPath = path.join(tmp, "next.md");
  const previousBin = process.env.GEMINI_BIN;
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  process.env.GEMINI_BIN = "gemini";
  try {
    const result = await runGeminiTurn(fakeDir, {
      prompt: "ECHO:ok",
      transcriptPath,
      resumeTranscriptPath: priorPath
    });
    assert.equal(result.status, 0);
    assert.equal(result.transcriptTruncated, true);
  } finally {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.GEMINI_BIN; else process.env.GEMINI_BIN = previousBin;
  }
});

test("runGeminiTurn surfaces signal-cancelled exits with status != 0", async () => {
  const { env, fakeDir } = withFakeEnv();
  const tmp = makeTempDir();
  const transcriptPath = path.join(tmp, "transcript.md");
  const controller = new AbortController();
  const previousBin = process.env.GEMINI_BIN;
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  process.env.GEMINI_BIN = "gemini";
  try {
    const promise = runGeminiTurn(fakeDir, {
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
    if (previousBin === undefined) delete process.env.GEMINI_BIN; else process.env.GEMINI_BIN = previousBin;
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

test("companion task --print-command includes context inventory without invoking gemini or creating a job", () => {
  const { env } = withFakeEnv();
  const workspace = makeTempDir();
  fs.writeFileSync(path.join(workspace, "notes.txt"), "context\n", "utf8");
  const pluginData = makeTempDir();
  const invocationLog = path.join(makeTempDir(), "gemini-invocations.log");

  const result = run(
    process.execPath,
    [COMPANION, "task", "--dirs", ".", "--print-command", "describe this"],
    {
      cwd: workspace,
      env: { ...env, [PLUGIN_DATA_ENV]: pluginData, FAKE_GEMINI_INVOCATION_LOG: invocationLog }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Assembled prompt bytes:/);
  assert.match(result.stdout, /notes\.txt \(\d+ bytes\)/);
  assert.doesNotMatch(result.stdout, /task-[a-z0-9]+/);
  assert.equal(fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8") : "", "");
});

test("companion setup --json reports ready when fake gemini and key are present", () => {
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
  assert.equal(payload.gemini.available, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("companion setup --json reports needs-attention when no auth is set", () => {
  const { fakeDir } = withFakeEnv();
  const env = { ...process.env, PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`, GEMINI_BIN: "gemini" };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
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
  assert.equal(payload.gemini.available, true);
  assert.equal(payload.auth.loggedIn, false);
});

test("runGeminiTurn captures the full output even with a large final write", async () => {
  const { env } = withFakeEnv();
  const workspace = makeTempDir();
  const transcriptPath = path.join(workspace, "t.json");
  const payload = "X".repeat(64 * 1024);
  const result = await runGeminiTurn(workspace, {
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

test("runGeminiTurn invokes onChildPid with the spawned child's PID, not the caller's", async () => {
  const { env, fakeDir } = withFakeEnv();
  const workspace = makeTempDir();
  const transcriptPath = path.join(workspace, "transcript.json");

  const captured = [];
  const result = await runGeminiTurn(workspace, {
    prompt: "ECHO:hello-world",
    transcriptPath,
    env,
    onChildPid: (pid) => captured.push(pid)
  });

  assert.equal(result.status, 0, "fake gemini should exit cleanly");
  assert.equal(captured.length, 1, "onChildPid must fire exactly once per turn");
  const [pid] = captured;
  assert.equal(typeof pid, "number");
  assert.notEqual(pid, process.pid, "captured PID must be the child's, not the test runner's");
  assert.notEqual(pid, fakeDir, "sanity: pid is a number, not a path");
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
