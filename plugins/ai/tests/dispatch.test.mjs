import test from "node:test";
import assert from "node:assert/strict";

import {
  mapUmbrellaCommandToProviderArgs,
  spawnInHouseCompanion
} from "../scripts/lib/dispatch.mjs";
import { writeFakeCompanion } from "./fake-companion.mjs";

test("mapUmbrellaCommandToProviderArgs: review without focus stays as review", () => {
  assert.deepEqual(
    mapUmbrellaCommandToProviderArgs("review", ["--scope=diff", "--json"]),
    ["review", "--scope=diff", "--json"]
  );
});

test("mapUmbrellaCommandToProviderArgs: review with focus text routes to adversarial-review", () => {
  assert.deepEqual(
    mapUmbrellaCommandToProviderArgs("review", ["--scope=diff", "review the auth flow"]),
    ["adversarial-review", "--scope=diff", "review the auth flow"]
  );
});

test("mapUmbrellaCommandToProviderArgs: rescue routes to task", () => {
  assert.deepEqual(
    mapUmbrellaCommandToProviderArgs("rescue", ["investigate the bug"]),
    ["task", "investigate the bug"]
  );
});

test("mapUmbrellaCommandToProviderArgs: gater routes to adversarial-review", () => {
  assert.deepEqual(
    mapUmbrellaCommandToProviderArgs("gater", []),
    ["adversarial-review"]
  );
});

test("mapUmbrellaCommandToProviderArgs: unknown commands forward unchanged", () => {
  assert.deepEqual(
    mapUmbrellaCommandToProviderArgs("setup", ["--json"]),
    ["setup", "--json"]
  );
});

test("spawnInHouseCompanion captures stdout and reports status=0 on success", async () => {
  const { companionPath } = writeFakeCompanion();
  const result = await spawnInHouseCompanion(
    { id: "fake", companionPath },
    ["review"]
  );
  assert.equal(result.providerId, "fake");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"verdict":\s*"approve"/);
  assert.equal(result.timedOut, false);
});

test("spawnInHouseCompanion surfaces non-zero exit codes and stderr", async () => {
  const { companionPath } = writeFakeCompanion();
  const result = await spawnInHouseCompanion(
    { id: "fake", companionPath },
    ["review", "--explode"]
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /simulated failure/);
});

test("spawnInHouseCompanion enforces timeoutMs and reports timedOut", async () => {
  const { companionPath } = writeFakeCompanion();
  const result = await spawnInHouseCompanion(
    { id: "fake", companionPath },
    ["sleep", "5000"],
    { timeoutMs: 200 }
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 124);
});

test("spawnInHouseCompanion returns a uniform shape with all expected fields", async () => {
  const { companionPath } = writeFakeCompanion();
  const result = await spawnInHouseCompanion(
    { id: "fake", companionPath },
    ["echo", "hi"]
  );
  for (const key of ["providerId", "status", "stdout", "stderr", "signal", "error", "timedOut", "stdoutOverrun"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(result, key), `missing field: ${key}`);
  }
  assert.equal(result.providerId, "fake");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^hi/);
});
