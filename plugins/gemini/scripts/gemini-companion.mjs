#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "@ai-plugins-cc/core/args";
import {
  collectContext,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  splitCommaList
} from "@ai-plugins-cc/core/context";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskTranscript,
    getGeminiAuthStatus,
    getGeminiAvailability,
    getSessionRuntimeStatus,
    parseStructuredOutput,
    prepareGeminiTurnInvocation,
    readOutputSchema,
    runGeminiReview,
    runGeminiTurn
  } from "@ai-plugins-cc/core/gemini";
import { readStdinIfPiped } from "@ai-plugins-cc/core/fs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "@ai-plugins-cc/core/git";
import { binaryAvailable, terminateProcessTree } from "@ai-plugins-cc/core/process";
import { loadPromptTemplate, interpolateTemplate } from "@ai-plugins-cc/core/prompts";
import {
  generateJobId,
  getConfig,
  listJobs,
  resolveJobsDir,
  setConfig,
  upsertJob,
  writeJobFile
} from "@ai-plugins-cc/core/state";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "@ai-plugins-cc/core/job-control";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "@ai-plugins-cc/core/tracked-jobs";
import { resolveWorkspaceRoot } from "@ai-plugins-cc/core/workspace";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskCommandPreview,
  renderTaskResult
} from "@ai-plugins-cc/core/render";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const MODEL_ALIASES = new Map([
  ["pro", "gemini-2.5-pro"],
  ["flash", "gemini-2.5-flash"]
]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/gemini-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/gemini-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/gemini-companion.mjs task [--background] [--resume-last|--resume|--fresh] [--model <model|pro|flash>] [prompt]",
      "  node scripts/gemini-companion.mjs task-resume-candidate [--json]",
      "  node scripts/gemini-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/gemini-companion.mjs result [job-id] [--json]",
      "  node scripts/gemini-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) return null;
  const normalized = String(model).trim();
  if (!normalized) return null;
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function resolveTranscriptPath(workspaceRoot, jobId) {
  return path.join(resolveJobsDir(workspaceRoot), jobId, "transcript.md");
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const geminiStatus = getGeminiAvailability(cwd);
  const authStatus = await getGeminiAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!geminiStatus.available) {
    nextSteps.push("Install the Gemini CLI with `npm install -g @google/gemini-cli`.");
  }
  if (geminiStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Set `GEMINI_API_KEY` (Google AI Studio) or run `gcloud auth application-default login` for Vertex AI.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/gemini:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && geminiStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    gemini: geminiStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildReviewPrompt(reviewName, context, focusText) {
  const templateName = reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  const schema = readOutputSchema(REVIEW_SCHEMA);
  return interpolateTemplate(template, {
    REVIEW_KIND: reviewName,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
    REVIEW_OUTPUT_SCHEMA: JSON.stringify(schema, null, 2)
  });
}

function ensureGeminiAvailable(cwd) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    throw new Error("Gemini CLI is not installed. Install it with `npm install -g @google/gemini-cli`, then rerun `/gemini:setup`.");
  }
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) return jobs;
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        (job.transcriptPath || job.threadId) &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskTranscript(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /gemini:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask?.transcriptPath && fs.existsSync(trackedTask.transcriptPath)) {
    return { transcriptPath: trackedTask.transcriptPath, jobId: trackedTask.id };
  }

  if (sessionId) return null;

  const fallback = await findLatestTaskTranscript(workspaceRoot);
  if (fallback?.transcriptPath && fs.existsSync(fallback.transcriptPath)) {
    return { transcriptPath: fallback.transcriptPath, jobId: fallback.id ?? null };
  }
  return null;
}

async function executeReviewRun(request) {
  ensureGeminiAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(reviewName, context, focusText);

  const transcriptPath = resolveTranscriptPath(resolveWorkspaceRoot(request.cwd), request.jobId);
  const result = await runGeminiReview(context.repoRoot, {
    prompt,
    model: request.model,
    transcriptPath,
    onProgress: request.onProgress
  });

  const parsed = parseStructuredOutput(result.reviewText, {
    status: result.status,
    failureMessage: result.error ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    transcriptPath: result.transcriptPath,
    transcriptTruncated: result.transcriptTruncated,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    gemini: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.reviewText,
      reasoning: []
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    transcriptPath: result.transcriptPath,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: []
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.reviewText, `${reviewName} finished.`),
    jobTitle: `Gemini ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureGeminiAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeTranscriptPath = null;
  if (request.resumeLast) {
    const latest = await resolveLatestTrackedTaskTranscript(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latest) {
      throw new Error("No previous Gemini task transcript was found for this repository.");
    }
    resumeTranscriptPath = latest.transcriptPath;
  }

  if (!request.prompt && !resumeTranscriptPath) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const contextOptions = normalizeContextOptions(request.contextOptions ?? {});
  const context = hasContextRequest(contextOptions)
    ? collectContext({
        cwd: request.cwd,
        ...contextOptions
      })
    : emptyContextCollection();
  const contextSummary = summarizeContextCollection(context);
  if (hasContextRequest(contextOptions)) {
    request.onProgress?.({
      message: `Collected context: ${contextSummary.includedCount} included, ${contextSummary.skippedCount} skipped, ${contextSummary.byteEstimate} bytes.`,
      phase: "running",
      context: contextSummary
    });
  }

  const transcriptPath = resolveTranscriptPath(workspaceRoot, request.jobId);
  const turnPrompt = request.prompt || (resumeTranscriptPath ? DEFAULT_CONTINUE_PROMPT : "");
  const turnDefaults = {
    prompt: turnPrompt,
    defaultPrompt: resumeTranscriptPath ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    resumeTranscriptPath,
    contextBlock: context.promptBlock
  };
  const previewInvocation = prepareGeminiTurnInvocation(workspaceRoot, turnDefaults);
  if (request.background !== true && previewInvocation.assembledPromptBytes > 2_000_000) {
    request.onProgress?.({
      message: `Warning: assembled prompt is ${previewInvocation.assembledPromptBytes} bytes; consider rerunning with --background.`,
      phase: "running"
    });
  }

  const result = await runGeminiTurn(workspaceRoot, {
    prompt: turnPrompt,
    defaultPrompt: resumeTranscriptPath ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    transcriptPath,
    resumeTranscriptPath,
    contextBlock: context.promptBlock,
    onProgress: request.onProgress,
    onChildPid: request.onChildPid
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: [],
      transcriptTruncated: result.transcriptTruncated
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    transcriptPath: result.transcriptPath,
    transcriptTruncated: result.transcriptTruncated,
    rawOutput,
    touchedFiles: [],
    reasoningSummary: [],
    context: contextSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    transcriptPath: result.transcriptPath,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task"
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Gemini Review" : `Gemini ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Gemini Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Gemini Resume" : "Gemini Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /gemini:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") return "adversarial-review";
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary
  });
}

function buildTaskRequest({ cwd, model, prompt, resumeLast, jobId, background = false, contextOptions = {} }) {
  const normalizedContextOptions = normalizeContextOptions(contextOptions);
  return {
    cwd,
    model,
    prompt,
    resumeLast,
    jobId,
    background,
    contextOptions: normalizedContextOptions
  };
}

async function buildTaskPrintCommandPreview(request, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  let resumeTranscriptPath = null;
  if (request.resumeLast) {
    const latest = await resolveLatestTrackedTaskTranscript(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latest) {
      throw new Error("No previous Gemini task transcript was found for this repository.");
    }
    resumeTranscriptPath = latest.transcriptPath;
  }

  if (!request.prompt && !resumeTranscriptPath) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const contextOptions = normalizeContextOptions(request.contextOptions ?? {});
  const context = hasContextRequest(contextOptions)
    ? collectContext({
        cwd: request.cwd,
        ...contextOptions
      })
    : emptyContextCollection();
  const invocation = prepareGeminiTurnInvocation(request.cwd, {
    prompt: request.prompt || (resumeTranscriptPath ? DEFAULT_CONTINUE_PROMPT : ""),
    defaultPrompt: resumeTranscriptPath ? DEFAULT_CONTINUE_PROMPT : "",
    resumeTranscriptPath,
    contextBlock: context.promptBlock,
    model: request.model
  });

  return {
    argv: [invocation.bin, ...invocation.args],
    useStdin: invocation.useStdin,
    assembledPromptBytes: invocation.assembledPromptBytes,
    assembledPromptPreviewLines: invocation.assembledPromptPreviewLines,
    includedFiles: context.includedFiles,
    skippedFiles: context.skippedFiles,
    inventoryLines: context.inventoryLines,
    transcriptTruncated: invocation.transcriptTruncated
  };
}

function normalizeTaskContextOptions(options) {
  return normalizeContextOptions({
    dirs: splitCommaList(options.dirs),
    files: splitCommaList(options.files),
    maxFiles: parseInt(options["max-files"], 10) || DEFAULT_MAX_FILES,
    maxFileBytes: parseInt(options["max-file-bytes"], 10) || DEFAULT_MAX_FILE_BYTES
  });
}

function normalizeContextOptions(options = {}) {
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES;
  const maxFileBytes = Number.isInteger(options.maxFileBytes) ? options.maxFileBytes : DEFAULT_MAX_FILE_BYTES;
  return {
    dirs: Array.isArray(options.dirs) ? [...options.dirs] : splitCommaList(options.dirs),
    files: Array.isArray(options.files) ? [...options.files] : splitCommaList(options.files),
    maxFiles,
    maxFileBytes
  };
}

function hasContextRequest(contextOptions = {}) {
  return (contextOptions.dirs?.length ?? 0) > 0 || (contextOptions.files?.length ?? 0) > 0;
}

function emptyContextCollection() {
  return {
    inventoryLines: [],
    promptBlock: "",
    includedFiles: [],
    skippedFiles: []
  };
}

function summarizeContextCollection(context) {
  return {
    includedCount: context.includedFiles.length,
    skippedCount: context.skippedFiles.length,
    byteEstimate: Buffer.byteLength(context.promptBlock ?? "", "utf8"),
    includedFiles: context.includedFiles.map((file) => file.path)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "gemini-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request,
    transcriptPath: resolveTranscriptPath(job.workspaceRoot, job.id)
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: normalizeRequestedModel(options.model),
        focusText,
        reviewName: config.reviewName,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Review" });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd", "prompt-file", "dirs", "files", "max-files", "max-file-bytes"],
    booleanOptions: ["json", "resume-last", "resume", "fresh", "background", "print-command"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  if (options["print-command"] && options.background) {
    throw new Error("--print-command cannot be combined with --background because it does not create a job.");
  }

  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });
  const contextOptions = normalizeTaskContextOptions(options);

  requireTaskRequest(prompt, resumeLast);

  if (options["print-command"]) {
    const request = buildTaskRequest({
      cwd,
      model,
      prompt,
      resumeLast,
      jobId: null,
      background: false,
      contextOptions
    });
    const payload = await buildTaskPrintCommandPreview(request, options);
    outputCommandResult(payload, renderTaskCommandPreview(payload), options.json);
    return;
  }

  if (options.background) {
    ensureGeminiAvailable(cwd);

    const job = buildTaskJob(workspaceRoot, taskMetadata);
    const request = buildTaskRequest({
      cwd,
      model,
      prompt,
      resumeLast,
      jobId: job.id,
      background: true,
      contextOptions
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        prompt,
        resumeLast,
        jobId: job.id,
        background: false,
        contextOptions,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress,
        onChildPid: (pid) => {
          if (Number.isFinite(pid)) {
            upsertJob(workspaceRoot, { id: options["job-id"], providerPid: pid });
          }
        }
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            transcriptPath: candidate.transcriptPath ?? null,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  terminateProcessTree(job.pid ?? Number.NaN);
  const providerPid = existing.providerPid ?? job.providerPid ?? null;
  if (Number.isFinite(providerPid) && providerPid !== (job.pid ?? Number.NaN)) {
    terminateProcessTree(providerPid);
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    providerPid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
