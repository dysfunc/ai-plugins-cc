import process from "node:process";
import { upsertJob } from "@ai-plugins-cc/core/state";

const [, , workspace, jobId] = process.argv;
if (!workspace || !jobId) {
  console.error("usage: concurrent-state-writer.mjs <workspace> <jobId>");
  process.exit(2);
}

upsertJob(workspace, { id: jobId, status: "queued", note: jobId });
