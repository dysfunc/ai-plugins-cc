import test from "node:test";
import assert from "node:assert/strict";

import { spawnInHouseCompanion } from "../scripts/lib/dispatch.mjs";
import { renderCompareReport } from "../scripts/lib/render-compare.mjs";
import { writeFakeCompanion } from "./fake-companion.mjs";

// Drive the compare flow at the dispatcher level: spawn three fakes in
// parallel, hand the results to renderCompareReport, and assert on the
// rendered shape. This avoids depending on real gemini/grok/codex at test
// time while still exercising the umbrella's "uniform-shape + side-by-side"
// contract end-to-end.
async function runFanOut(invocations) {
  return Promise.all(
    invocations.map(({ providerId, args }) =>
      spawnInHouseCompanion({ id: providerId, companionPath: providerId.companionPath ?? args.shift() }, args)
    )
  );
}

test("compare fan-out preserves provider order and per-provider status", async () => {
  const a = writeFakeCompanion();
  const b = writeFakeCompanion();
  const c = writeFakeCompanion();

  const results = await Promise.all([
    spawnInHouseCompanion({ id: "alpha", companionPath: a.companionPath }, ["review"]),
    spawnInHouseCompanion({ id: "beta", companionPath: b.companionPath }, ["review", "--explode"]),
    spawnInHouseCompanion({ id: "gamma", companionPath: c.companionPath }, ["review"])
  ]);

  assert.deepEqual(results.map((r) => r.providerId), ["alpha", "beta", "gamma"]);
  assert.equal(results[0].status, 0);
  assert.notEqual(results[1].status, 0);
  assert.equal(results[2].status, 0);
});

test("renderCompareReport produces a fenced section per provider with status", async () => {
  const a = writeFakeCompanion();
  const b = writeFakeCompanion();

  const results = await Promise.all([
    spawnInHouseCompanion({ id: "alpha", companionPath: a.companionPath }, ["review"]),
    spawnInHouseCompanion({ id: "beta", companionPath: b.companionPath }, ["review", "--explode"])
  ]);

  const report = renderCompareReport(results);
  assert.match(report, /# AI Compare/);
  assert.match(report, /Providers: 2  •  ok: 1  •  failed: 1/);
  assert.match(report, /## alpha[\s\S]*Status: ok/);
  assert.match(report, /## beta[\s\S]*Status: failed/);
  assert.match(report, /simulated failure/);
});
