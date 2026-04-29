import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { readJsonFile } from "@ai-plugins-cc/core/fs";
import { binaryAvailable, terminateProcessTree } from "@ai-plugins-cc/core/process";
import { listJobs } from "@ai-plugins-cc/core/state";

const TASK_THREAD_PREFIX = "Gemini Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the prior transcript. Pick the next highest-value step and follow through until the task is resolved.";
const DEFAULT_BIN = process.env.GEMINI_BIN || "gemini";

const TRANSCRIPT_TURN_CAP = readNumberEnv("GEMINI_PLUGIN_TRANSCRIPT_TURN_CAP", 8);
const TRANSCRIPT_CHAR_CAP = readNumberEnv("GEMINI_PLUGIN_TRANSCRIPT_CHAR_CAP", 40_000);
const ARGV_PROMPT_LIMIT = readNumberEnv("GEMINI_PLUGIN_ARGV_PROMPT_LIMIT", 100_000);
const SIGKILL_GRACE_MS = 1_000;

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getGeminiAvailability(cwd) {
  return binaryAvailable(DEFAULT_BIN, ["--version"], { cwd });
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  return {
    mode: "direct",
    label: "direct invocation",
    detail: "Each Gemini task spawns a fresh CLI subprocess.",
    endpoint: null
  };
}

export async function getGeminiAuthStatus(cwd, options = {}) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      provider: null
    };
  }

  const env = options.env ?? process.env;
  if (env.GEMINI_API_KEY) {
    return {
      available: true,
      loggedIn: true,
      detail: "GEMINI_API_KEY is set in this environment.",
      source: "env",
      authMethod: "api-key",
      verified: null,
      provider: "google-ai-studio"
    };
  }
  if (env.GOOGLE_API_KEY) {
    return {
      available: true,
      loggedIn: true,
      detail: "GOOGLE_API_KEY is set in this environment.",
      source: "env",
      authMethod: "api-key",
      verified: null,
      provider: "google-ai-studio"
    };
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    return {
      available: true,
      loggedIn: true,
      detail: `Application default credentials referenced via GOOGLE_APPLICATION_CREDENTIALS=${env.GOOGLE_APPLICATION_CREDENTIALS}.`,
      source: "env",
      authMethod: "vertex-adc",
      verified: null,
      provider: "vertex-ai"
    };
  }

  return {
    available: true,
    loggedIn: false,
    detail: "No Gemini auth credential detected. Set GEMINI_API_KEY (Google AI Studio) or run `gcloud auth application-default login` for Vertex AI.",
    source: "env",
    authMethod: null,
    verified: null,
    provider: null
  };
}

export async function interruptGeminiTurn(_cwd, _params) {
  return {
    attempted: false,
    interrupted: false,
    transport: null,
    detail: "Gemini plugin cancels via process-tree termination; no in-flight RPC interrupt is available."
  };
}

export async function runGeminiTurn(cwd, options = {}) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    throw new Error("Gemini CLI is not installed. Install it with `npm install -g @google/gemini-cli`, then rerun `/gemini:setup`.");
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Gemini run.");
  }

  if (!options.transcriptPath) {
    throw new Error("runGeminiTurn requires a transcriptPath for this turn.");
  }

  const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const threadIdLike = path.basename(options.transcriptPath, path.extname(options.transcriptPath));

  emitProgress(options.onProgress, "Preparing Gemini turn.", "starting", { threadId: threadIdLike, turnId });

  const invocation = buildGeminiTurnInvocation(options, prompt);
  const { assembled, truncated, useStdin, args } = invocation;
  const child = spawn(DEFAULT_BIN, args, {
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  emitProgress(options.onProgress, `Gemini subprocess spawned (pid ${child.pid}).`, "starting", { threadId: threadIdLike, turnId });

  if (typeof options.onChildPid === "function" && Number.isFinite(child.pid)) {
    try {
      options.onChildPid(child.pid);
    } catch (_) {
      // onChildPid is a best-effort hook; never let it tear down the turn.
    }
  }

  let firstStdoutSeen = false;
  let stdout = "";
  let stderr = "";
  let exitedBySignal = null;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    if (!firstStdoutSeen) {
      firstStdoutSeen = true;
      emitProgress(options.onProgress, "Gemini producing output.", "running", { threadId: threadIdLike, turnId });
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (trimmed) emitProgress(options.onProgress, trimmed, "running", { threadId: threadIdLike, turnId, stderrMessage: trimmed });
    }
  });

  if (useStdin) {
    child.stdin.end(assembled);
  } else {
    child.stdin.end();
  }

  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      killProcessTree(child);
    } else {
      options.abortSignal.addEventListener("abort", () => killProcessTree(child), { once: true });
    }
  }

  let timeoutHandle = null;
  let timedOut = false;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.timeoutMs);
  }

  // 'close' fires after the child has exited AND its stdio streams have
  // drained. Resolving on 'exit' could read the accumulator before the
  // final stdout/stderr chunks arrive on platforms where data events lag
  // the exit event.
  const exit = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", (err) => resolve({ code: 1, signal: null, error: err }));
  });
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (exit.signal) exitedBySignal = exit.signal;

  let status;
  if (timedOut) status = 124;
  else if (exit.code === 0 && !exit.error) status = 0;
  else status = 1;

  emitProgress(options.onProgress, "Gemini turn finalizing.", "finalizing", { threadId: threadIdLike, turnId });

  const finalMessage = stdout.trimEnd();
  if (status === 0 && finalMessage) {
    appendTranscriptTurn(options.transcriptPath, prompt, finalMessage);
  }

  return {
    status,
    threadId: threadIdLike,
    turnId,
    finalMessage,
    reasoningSummary: [],
    turn: null,
    error: exit.error ? String(exit.error) : (status === 0 ? null : (stderr.trim() || "Gemini exited non-zero.")),
    stderr: cleanStderr(stderr),
    exitedBySignal,
    transcriptPath: options.transcriptPath,
    transcriptTruncated: truncated,
    fileChanges: [],
    touchedFiles: [],
    commandExecutions: []
  };
}

export function prepareGeminiTurnInvocation(cwd, options = {}) {
  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Gemini run.");
  }

  const invocation = buildGeminiTurnInvocation(options, prompt);
  return {
    bin: DEFAULT_BIN,
    args: invocation.args,
    useStdin: invocation.useStdin,
    assembledPromptBytes: invocation.assembledPromptBytes,
    assembledPromptPreviewLines: invocation.assembled.split(/\r?\n/).slice(0, 20),
    transcriptTruncated: invocation.truncated
  };
}

export async function runGeminiReview(cwd, options = {}) {
  const reviewPrompt = options.prompt?.trim();
  if (!reviewPrompt) {
    throw new Error("runGeminiReview requires options.prompt with the rendered review template.");
  }

  emitProgress(options.onProgress, "Starting Gemini review.", "starting");
  const turnResult = await runGeminiTurn(cwd, {
    prompt: reviewPrompt,
    transcriptPath: options.transcriptPath,
    onProgress: options.onProgress,
    model: options.model,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    env: options.env
  });

  return {
    status: turnResult.status,
    threadId: turnResult.threadId,
    sourceThreadId: turnResult.threadId,
    turnId: turnResult.turnId,
    reviewText: turnResult.finalMessage,
    reasoningSummary: [],
    turn: null,
    error: turnResult.error,
    stderr: turnResult.stderr,
    transcriptPath: turnResult.transcriptPath,
    transcriptTruncated: turnResult.transcriptTruncated
  };
}

export async function findLatestTaskTranscript(cwd) {
  const jobs = listJobs(cwd);
  const candidates = [];
  for (const job of Object.values(jobs)) {
    if (!job?.transcriptPath) continue;
    if (!fs.existsSync(job.transcriptPath)) continue;
    candidates.push(job);
  }
  candidates.sort((a, b) => new Date(b.updatedAt ?? b.startedAt ?? 0) - new Date(a.updatedAt ?? a.startedAt ?? 0));
  return candidates[0] ?? null;
}

export function buildPersistentTaskThreadName(prompt) {
  const excerpt = String(prompt ?? "").trim().split(/\s+/).slice(0, 10).join(" ");
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Gemini did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const fenced = extractFencedJson(rawOutput);
  if (fenced) {
    try {
      return { parsed: JSON.parse(fenced), parseError: null, rawOutput, ...fallback };
    } catch (_) {
      // tolerant fallthrough
    }
  }

  try {
    return { parsed: JSON.parse(rawOutput), parseError: null, rawOutput, ...fallback };
  } catch (error) {
    return { parsed: null, parseError: error.message, rawOutput, ...fallback };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };

function buildCliArgs({ model, prompt }) {
  const args = [];
  if (model) args.push("--model", model);
  if (prompt != null) args.push("-p", prompt);
  return args;
}

function buildGeminiTurnInvocation(options, prompt) {
  const { assembled, truncated } = assemblePrompt({
    prompt,
    resumeTranscriptPath: options.resumeTranscriptPath,
    contextBlock: options.contextBlock
  });
  const assembledPromptBytes = Buffer.byteLength(assembled, "utf8");
  const useStdin = assembledPromptBytes > ARGV_PROMPT_LIMIT;
  const args = buildCliArgs({ model: options.model, prompt: useStdin ? null : assembled });
  return {
    assembled,
    truncated,
    useStdin,
    args,
    assembledPromptBytes
  };
}

function emitProgress(onProgress, message, phase, fields = {}) {
  if (typeof onProgress !== "function") return;
  onProgress({ message, phase, ...fields });
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    terminateProcessTree(child.pid);
  } catch (_) {
    try { child.kill("SIGTERM"); } catch (_) {}
  }
  setTimeout(() => {
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch (_) {}
    }
  }, SIGKILL_GRACE_MS).unref?.();
}

function cleanStderr(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

function extractFencedJson(text) {
  const match = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  return match ? match[1].trim() : null;
}

function assemblePrompt({ prompt, resumeTranscriptPath, contextBlock }) {
  const sections = [];
  const normalizedContext = String(contextBlock ?? "").trimEnd();
  if (normalizedContext) {
    sections.push(normalizedContext);
  }

  let transcriptTruncated = false;
  if (resumeTranscriptPath) {
    let prior;
    try { prior = fs.readFileSync(resumeTranscriptPath, "utf8"); }
    catch (_) { prior = ""; }
    if (prior.trim()) {
      const { text, truncated } = truncateTranscript(prior);
      transcriptTruncated = truncated;
      const banner = truncated ? "(Older turns omitted; transcript truncated.)\n\n" : "";
      sections.push(`## Prior conversation\n${banner}${text}`);
    }
  }

  if (sections.length === 0) {
    return { assembled: prompt, truncated: false };
  }

  sections.push(`## New request\n${prompt}`);
  return { assembled: sections.join("\n\n"), truncated: transcriptTruncated };
}

function truncateTranscript(transcript) {
  const turns = transcript.split(/(?=^## Turn \d+)/m).filter((s) => s.trim());
  let truncated = turns.length > TRANSCRIPT_TURN_CAP;
  let kept = truncated ? turns.slice(-TRANSCRIPT_TURN_CAP) : turns.slice();
  let text = kept.join("");
  while (text.length > TRANSCRIPT_CHAR_CAP && kept.length > 1) {
    kept.shift();
    text = kept.join("");
    truncated = true;
  }
  if (text.length > TRANSCRIPT_CHAR_CAP) {
    text = text.slice(-TRANSCRIPT_CHAR_CAP);
    truncated = true;
  }
  return { text, truncated };
}

function appendTranscriptTurn(transcriptPath, prompt, answer) {
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const existing = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, "utf8") : "";
  const turnNumber = (existing.match(/^## Turn \d+/gm) ?? []).length + 1;
  const block = `## Turn ${turnNumber}\nUser: ${prompt}\n\nAssistant: ${answer}\n\n`;
  fs.appendFileSync(transcriptPath, block);
}
