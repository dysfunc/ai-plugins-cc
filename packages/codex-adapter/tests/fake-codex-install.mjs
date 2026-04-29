import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Build a directory tree on disk that looks like an installed
 * openai/codex-plugin-cc release, just enough for discovery and invocation
 * tests to operate against. The fake codex-companion.mjs script reacts to
 * a small set of subcommands defined inline.
 */
export function writeFakeCodexInstall(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-install-"));
  const companionDir = path.join(root, "plugins", "codex", "scripts");
  const manifestDir = path.join(root, "plugins", "codex", ".claude-plugin");
  fs.mkdirSync(companionDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });

  const version = options.version ?? "1.0.4";
  fs.writeFileSync(
    path.join(manifestDir, "plugin.json"),
    JSON.stringify({ name: "codex", version, description: "Fake codex install for tests." }, null, 2),
    "utf8"
  );

  const companionPath = path.join(companionDir, "codex-companion.mjs");
  fs.writeFileSync(companionPath, COMPANION_SOURCE, { mode: 0o755 });

  return { root, companionPath, version };
}

const COMPANION_SOURCE = `#!/usr/bin/env node
// Minimal fake codex-companion that supports just enough to test the adapter.
//   review --json                 → emit the canned review object
//   review --json --shape=bad     → emit invalid JSON shape (missing findings)
//   review --json --shape=unknown → emit unknown verdict
//   review --json --explode       → exit 1 with stderr message
//   sleep <ms>                    → sleep N ms before exiting (timeout test)
//   burst <bytes>                 → write N bytes of stdout (cap test)
//   --version                     → print "codex-fake X.Y.Z"

const args = process.argv.slice(2);

function flush(code) {
  let pending = 2;
  const done = () => { pending -= 1; if (pending === 0) process.exit(code); };
  process.stdout.end(done);
  process.stderr.end(done);
}

if (args.includes("--version")) {
  process.stdout.write("codex-fake 1.0.4\\n");
  flush(0);
} else if (args[0] === "sleep") {
  const ms = Number(args[1] ?? "0");
  setTimeout(() => flush(0), ms);
} else if (args[0] === "burst") {
  const bytes = Number(args[1] ?? "0");
  process.stdout.write("X".repeat(bytes));
  flush(0);
} else if (args[0] === "review" && args.includes("--json")) {
  if (args.includes("--explode")) {
    process.stderr.write("simulated codex failure\\n");
    flush(1);
  } else {
    const shape = (args.find((a) => a.startsWith("--shape=")) || "").slice("--shape=".length);
    let payload;
    if (shape === "bad") {
      payload = { verdict: "approve", summary: "missing findings array" };
    } else if (shape === "unknown") {
      payload = { verdict: "ship-it", summary: "ok", findings: [] };
    } else {
      payload = {
        verdict: "approve",
        summary: "Fake codex review.",
        findings: [
          {
            severity: "low",
            title: "nit",
            body: "Trivial style note.",
            file: "src/index.mjs",
            line_start: 1,
            line_end: 1,
            confidence: 0.5,
            recommendation: "Tidy."
          }
        ],
        next_steps: ["No further action needed."]
      };
    }
    process.stdout.write(JSON.stringify(payload, null, 2) + "\\n");
    flush(0);
  }
} else {
  process.stderr.write("fake-codex: unknown command\\n");
  flush(2);
}
`;
