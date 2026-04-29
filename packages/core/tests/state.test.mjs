import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState
} from "@ai-plugins-cc/core/state";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRITER_SCRIPT = path.join(TESTS_DIR, "concurrent-state-writer.mjs");

function writeTranscript(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
  return filePath;
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true, `expected ${stateDir} to start with ${os.tmpdir()}`);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousPluginDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).filter((entry) => /^job-\d+\.(json|log)$/.test(entry)).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("saveState removes transcript files for pruned jobs", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobsDir = path.dirname(resolveJobFile(workspace, "anything"));
  const transcriptDirA = path.join(jobsDir, "task-A");
  const transcriptDirB = path.join(jobsDir, "task-B");
  const transcriptA = writeTranscript(path.join(transcriptDirA, "transcript.md"), "## Turn 1\nUser: a\n");
  const transcriptB = writeTranscript(path.join(transcriptDirB, "transcript.md"), "## Turn 1\nUser: b\n");

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          { id: "task-A", status: "completed", transcriptPath: transcriptA, updatedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
          { id: "task-B", status: "completed", transcriptPath: transcriptB, updatedAt: "2026-01-02T00:00:00Z", createdAt: "2026-01-02T00:00:00Z" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  // Drop task-A by rewriting state without it.
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      { id: "task-B", status: "completed", transcriptPath: transcriptB, updatedAt: "2026-01-02T00:00:00Z", createdAt: "2026-01-02T00:00:00Z" }
    ]
  });

  assert.equal(fs.existsSync(transcriptA), false, "pruned job's transcript must be deleted");
  assert.equal(fs.existsSync(transcriptB), true, "retained job's transcript must remain");
});

test("concurrent upsertJob writes do not lose updates", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const concurrency = 8;
    const ids = Array.from({ length: concurrency }, (_, i) => `concurrent-${i}`);

    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir };
    const runs = ids.map(
      (id) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [WRITER_SCRIPT, workspace, id],
            { env, stdio: ["ignore", "pipe", "pipe"] }
          );
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`writer ${id} exited ${code}: ${stderr}`));
          });
        })
    );

    await Promise.all(runs);

    const jobs = listJobs(workspace);
    const recordedIds = new Set(jobs.map((job) => job.id));
    for (const id of ids) {
      assert.equal(recordedIds.has(id), true, `expected job ${id} to survive concurrent writes`);
    }
    assert.equal(jobs.length, concurrency, "every concurrent upsert must be recorded");
  } finally {
    if (previousPluginDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});
