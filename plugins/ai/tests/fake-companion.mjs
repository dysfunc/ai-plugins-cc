import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Write a minimal fake provider companion script to a temp file. The fake
 * understands a tiny argv vocabulary so dispatch tests can probe the
 * umbrella's spawn behavior without touching real provider code.
 *
 *   review               → exit 0, stdout '{"verdict":"approve","summary":"ok","findings":[]}'
 *   review --explode     → exit 1, stderr 'fake: simulated failure'
 *   sleep <ms>           → exit 0 after sleeping
 *   echo <text>          → exit 0, stdout text\n
 */
export function writeFakeCompanion() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ai-companion-"));
  const file = path.join(dir, "fake-companion.mjs");
  fs.writeFileSync(file, COMPANION_SOURCE, { mode: 0o755 });
  return { dir, companionPath: file };
}

const COMPANION_SOURCE = `#!/usr/bin/env node
const args = process.argv.slice(2);

function flush(code) {
  let pending = 2;
  const done = () => { pending -= 1; if (pending === 0) process.exit(code); };
  process.stdout.end(done);
  process.stderr.end(done);
}

if (args[0] === "review") {
  if (args.includes("--explode")) {
    process.stderr.write("fake: simulated failure\\n");
    flush(1);
  } else {
    process.stdout.write(JSON.stringify({ verdict: "approve", summary: "ok", findings: [] }));
    process.stdout.write("\\n");
    flush(0);
  }
} else if (args[0] === "sleep") {
  const ms = Number(args[1] ?? "0");
  setTimeout(() => flush(0), ms);
} else if (args[0] === "echo") {
  process.stdout.write((args[1] ?? "") + "\\n");
  flush(0);
} else {
  process.stderr.write("fake: unknown command\\n");
  flush(2);
}
`;
