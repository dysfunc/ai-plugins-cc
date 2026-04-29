import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult, renderTaskResult } from "@ai-plugins-cc/core/render";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Gemini returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult shows transcript path for completed task jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "task-123",
      status: "completed",
      title: "Gemini Task",
      jobClass: "task",
      transcriptPath: "/tmp/example/jobs/task-123/transcript.md"
    },
    {
      transcriptPath: "/tmp/example/jobs/task-123/transcript.md",
      result: {
        rawOutput: "All checks passed.",
        transcriptTruncated: true
      }
    }
  );

  assert.match(output, /All checks passed\./);
  assert.match(output, /Transcript: \/tmp\/example\/jobs\/task-123\/transcript\.md/);
  assert.match(output, /\(truncated when assembled\)/);
  assert.doesNotMatch(output, /Codex/);
});

test("renderTaskResult surfaces the transcript-truncation note", () => {
  const output = renderTaskResult(
    {
      rawOutput: "Here is the answer.",
      transcriptTruncated: true
    },
    { title: "Gemini Task", jobId: "task-1" }
  );

  assert.match(output, /Here is the answer\./);
  assert.match(output, /prior conversation transcript was truncated/i);
});
