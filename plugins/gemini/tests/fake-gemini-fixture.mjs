import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

/**
 * Writes a fake `gemini` shim binary into a temp dir and returns the directory.
 * The shim is argv-driven: it reads its prompt from --prompt-file or the -p
 * argument, and emits a canned reply that depends on a marker token in the
 * prompt. This keeps tests hermetic and avoids needing the real Gemini CLI.
 *
 *   prompt contains "ECHO:..."        → stdout = "..."
 *   prompt contains "FAIL_REASON:..." → exit 1, stderr = "..."
 *   prompt contains "SLEEP:N"         → sleep N seconds before exiting (for cancel tests)
 *   --version                          → "gemini-fake 0.0.1"
 *   anything else                      → stdout = JSON-encoded canned review
 */
export function writeFakeGeminiBinary({ name = "gemini" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gemini-"));
  const binaryName = process.platform === "win32" ? `${name}.cmd` : name;
  const binaryPath = path.join(dir, binaryName);

  if (process.platform === "win32") {
    writeExecutable(
      binaryPath,
      `@echo off\r\nnode "${binaryPath}.mjs" %*\r\n`
    );
  }

const shimSource = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");

const args = process.argv.slice(2);
if (process.env.FAKE_GEMINI_INVOCATION_LOG) {
  fs.appendFileSync(process.env.FAKE_GEMINI_INVOCATION_LOG, JSON.stringify(process.argv) + "\\n", "utf8");
}

if (args.includes("--version")) {
  process.stdout.write("gemini-fake 0.0.1\\n");
  process.exit(0);
}

let prompt = "";
const promptFlagIndex = args.indexOf("-p");
if (promptFlagIndex !== -1 && args[promptFlagIndex + 1] != null) {
  prompt = args[promptFlagIndex + 1];
} else {
  prompt = fs.readFileSync(0, "utf8");
}

const echoMatch = /ECHO:([\\s\\S]+?)(?:\\n|$)/.exec(prompt);
if (echoMatch) {
  process.stdout.write(echoMatch[1]);
  process.stdout.write("\\n");
  process.exit(0);
}

const failMatch = /FAIL_REASON:([^\\n]+)/.exec(prompt);
if (failMatch) {
  process.stderr.write(failMatch[1] + "\\n");
  process.exit(1);
}

const sleepMatch = /SLEEP:(\\d+)/.exec(prompt);
if (sleepMatch) {
  const ms = Number(sleepMatch[1]) * 1000;
  setTimeout(() => process.exit(0), ms);
  process.stderr.write("running\\n");
  return;
}

const cannedReview = {
  verdict: "approve",
  summary: "Fake gemini review.",
  findings: [],
  next_steps: []
};
process.stdout.write(JSON.stringify(cannedReview, null, 2) + "\\n");
process.exit(0);
`;

  if (process.platform === "win32") {
    fs.writeFileSync(`${binaryPath}.mjs`, shimSource, { encoding: "utf8" });
  } else {
    writeExecutable(binaryPath, shimSource);
  }

  return { dir, binaryPath };
}

/**
 * Returns env additions that, when merged with process.env, point the gemini
 * adapter at the fake shim and supply a fake API key.
 */
export function fakeGeminiEnv(fakeBinDir) {
  return {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    GEMINI_BIN: "gemini",
    GEMINI_API_KEY: "fake-key-for-tests"
  };
}
