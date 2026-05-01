import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendLogBlock,
  appendLogLine,
  scrubSecrets
} from "../src/tracked-jobs.mjs";

test("scrubSecrets masks an xAI API key while keeping the prefix", () => {
  const input = "401 Unauthorized for key xai-abcdEFGH1234567890ijklMNOP";
  const out = scrubSecrets(input);
  assert.match(out, /xai-<redacted>/);
  assert.equal(out.includes("abcdEFGH"), false);
});

test("scrubSecrets masks a Google AI Studio key", () => {
  const out = scrubSecrets("config: AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  assert.match(out, /AIza<redacted>/);
});

test("scrubSecrets masks an Anthropic key before the generic OpenAI pattern", () => {
  const out = scrubSecrets("sk-ant-abcdef1234567890wxyz");
  assert.match(out, /sk-ant-<redacted>/);
  assert.equal(out.includes("sk-<redacted>"), false, "should not double-mask");
});

test("scrubSecrets masks a Bearer token in an Authorization header", () => {
  const out = scrubSecrets("Authorization: Bearer 1234567890abcdef.signature");
  assert.match(out, /Bearer <redacted>/);
});

test("scrubSecrets is a no-op on safe text", () => {
  const safe = "verdict: approve. summary: nothing to ship-block.";
  assert.equal(scrubSecrets(safe), safe);
});

test("scrubSecrets handles null/undefined without throwing", () => {
  assert.equal(scrubSecrets(null), "");
  assert.equal(scrubSecrets(undefined), "");
});

test("appendLogLine writes the scrubbed form to disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracked-jobs-secrets-"));
  const logFile = path.join(dir, "log.txt");
  fs.writeFileSync(logFile, "");
  appendLogLine(logFile, "leaked sk-abcdefghijklmnopqrstuvwxyz1234 in error");
  const contents = fs.readFileSync(logFile, "utf8");
  assert.match(contents, /sk-<redacted>/);
  assert.equal(contents.includes("abcdefghij"), false);
});

test("appendLogBlock writes the scrubbed body to disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracked-jobs-secrets-block-"));
  const logFile = path.join(dir, "log.txt");
  fs.writeFileSync(logFile, "");
  appendLogBlock(logFile, "Final output", "key=xai-abcd1234efgh5678ijkl");
  const contents = fs.readFileSync(logFile, "utf8");
  assert.match(contents, /xai-<redacted>/);
  assert.equal(contents.includes("abcd1234"), false);
});
