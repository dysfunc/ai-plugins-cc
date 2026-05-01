import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

// Canonical env var that namespaces a Claude session for ai-plugins-cc.
// Older deployments may still set GEMINI_COMPANION_SESSION_ID; readers
// fall back to that name when looking up the current session id.
export const SESSION_ID_ENV = "AI_PLUGINS_CC_SESSION_ID";
export const LEGACY_SESSION_ID_ENVS = ["GEMINI_COMPANION_SESSION_ID"];

export function readSessionId(env = process.env, sessionIdEnv = SESSION_ID_ENV) {
  if (env[sessionIdEnv]) return env[sessionIdEnv];
  for (const legacy of LEGACY_SESSION_ID_ENVS) {
    if (env[legacy]) return env[legacy];
  }
  return undefined;
}

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

// Patterns for tokens we never want to land in workspace log files. The
// underlying provider CLIs occasionally print full API keys when they hit
// an authentication failure ("401 Unauthorized for key xai-..."), and
// those messages get captured into stderr-derived progress events that
// land here. Workspace log files persist on disk indefinitely, so a leak
// here is recoverable months later by anyone with FS access.
//
// Replacement keeps a short prefix so the *kind* of credential is still
// debuggable, but the rest is masked. Order matters — match the more
// specific Anthropic prefix before the generic `sk-`.
const SECRET_PATTERNS = [
  // Anthropic: sk-ant-<base64ish>
  { regex: /sk-ant-[A-Za-z0-9_-]{8,}/g, mask: "sk-ant-<redacted>" },
  // OpenAI / Codex: sk-<base64ish> (~20+ chars)
  { regex: /\bsk-[A-Za-z0-9_-]{16,}/g, mask: "sk-<redacted>" },
  // xAI: xai-<base64ish> (~40+ chars in practice)
  { regex: /\bxai-[A-Za-z0-9_-]{16,}/g, mask: "xai-<redacted>" },
  // Google AI Studio: AIza<35 base64ish>
  { regex: /\bAIza[A-Za-z0-9_-]{20,}/g, mask: "AIza<redacted>" },
  // Bearer <token> in Authorization headers
  { regex: /Bearer\s+[A-Za-z0-9._-]{8,}/g, mask: "Bearer <redacted>" }
];

/**
 * Mask common API key patterns in a string before it reaches the disk.
 * No-ops on empty / non-string input. Idempotent — re-running doesn't
 * double-mask because the replacement strings don't match the patterns.
 */
export function scrubSecrets(text) {
  let out = String(text ?? "");
  if (!out) return out;
  for (const { regex, mask } of SECRET_PATTERNS) {
    out = out.replace(regex, mask);
  }
  return out;
}

export function appendLogLine(logFile, message) {
  const normalized = scrubSecrets(String(message ?? "").trim());
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  const scrubbedBody = scrubSecrets(String(body).trimEnd());
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${scrubbedBody}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = readSessionId(env, options.sessionIdEnv ?? SESSION_ID_ENV);
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({
  stderr = false,
  logFile = null,
  onEvent = null,
  stderrPrefix = "ai"
} = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[${stderrPrefix}] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      transcriptPath: execution.transcriptPath ?? runningRecord.transcriptPath ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      transcriptPath: execution.transcriptPath ?? runningRecord.transcriptPath ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}
