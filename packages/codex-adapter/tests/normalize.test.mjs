import test from "node:test";
import assert from "node:assert/strict";

import { normalizeReviewOutput } from "@ai-plugins-cc/codex-adapter";

const VALID = JSON.stringify({
  verdict: "approve",
  summary: "ship it",
  findings: [
    {
      severity: "low",
      title: "nit",
      body: "trivial",
      file: "src/x.mjs",
      line_start: 1,
      line_end: 1,
      confidence: 0.7
    }
  ],
  next_steps: ["go"]
});

test("normalizeReviewOutput accepts a well-formed upstream review", () => {
  const result = normalizeReviewOutput(VALID);
  assert.equal(result.ok, true);
  assert.equal(result.review.verdict, "approve");
  assert.equal(result.review.findings.length, 1);
  assert.deepEqual(result.review.next_steps, ["go"]);
});

test("normalizeReviewOutput tolerates leading prose before the JSON object", () => {
  const noisy = `chatty preamble that should be ignored\n\n${VALID}`;
  const result = normalizeReviewOutput(noisy);
  assert.equal(result.ok, true);
});

test("normalizeReviewOutput defaults next_steps to [] when missing", () => {
  const noNextSteps = JSON.stringify({
    verdict: "approve",
    summary: "ok",
    findings: []
  });
  const result = normalizeReviewOutput(noNextSteps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.review.next_steps, []);
});

test("normalizeReviewOutput rejects empty stdout", () => {
  const result = normalizeReviewOutput("");
  assert.equal(result.ok, false);
  assert.match(result.error, /empty stdout/);
});

test("normalizeReviewOutput rejects malformed JSON", () => {
  const result = normalizeReviewOutput("{ this is not json ");
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});

test("normalizeReviewOutput rejects an unknown verdict and names the upstream version", () => {
  const out = JSON.stringify({ verdict: "ship-it", summary: "x", findings: [] });
  const result = normalizeReviewOutput(out, { upstreamVersion: "1.2.3" });
  assert.equal(result.ok, false);
  assert.match(result.error, /verdict "ship-it"/);
});

test("normalizeReviewOutput names the missing top-level key with version diagnostic", () => {
  const out = JSON.stringify({ verdict: "approve", summary: "x" });
  const result = normalizeReviewOutput(out, { upstreamVersion: "1.2.3" });
  assert.equal(result.ok, false);
  assert.match(result.error, /missing required top-level key "findings"/);
  assert.match(result.error, /unsupported upstream version \(1\.2\.3\)/);
});

test("normalizeReviewOutput rejects a finding missing required fields", () => {
  const out = JSON.stringify({
    verdict: "approve",
    summary: "x",
    findings: [{ severity: "low", title: "t" }]
  });
  const result = normalizeReviewOutput(out);
  assert.equal(result.ok, false);
  assert.match(result.error, /finding\[0\] is missing required field "body"/);
});

test("normalizeReviewOutput rejects an unknown severity", () => {
  const out = JSON.stringify({
    verdict: "approve",
    summary: "x",
    findings: [{ severity: "cosmic", title: "t", body: "b", file: "f" }]
  });
  const result = normalizeReviewOutput(out);
  assert.equal(result.ok, false);
  assert.match(result.error, /severity is "cosmic"/);
});
