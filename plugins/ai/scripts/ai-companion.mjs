#!/usr/bin/env node

import process from "node:process";

import { installCodexUpstream } from "@ai-plugins-cc/codex-adapter";

import { dispatchToProvider, dispatchCompare } from "./lib/dispatch.mjs";
import { resolveProvider, resolveCompareProviders } from "./lib/config.mjs";
import { renderCompareReport } from "./lib/render-compare.mjs";

const COMMANDS = new Set(["review", "rescue", "gater", "compare", "codex-update"]);

function usage(stream = process.stderr) {
  stream.write(
    [
      "Usage: ai-companion.mjs <command> [--provider=ID] [--providers=A,B,C] [--json] [...args]",
      "Commands: review | rescue | gater | compare | codex-update",
      "Examples:",
      "  ai-companion.mjs review --provider=gemini --scope=diff",
      "  ai-companion.mjs compare --providers=gemini,codex --scope=diff",
      "  ai-companion.mjs codex-update             # install pinned upstream codex",
      "  ai-companion.mjs codex-update --tag=v1.0.5 # override the pinned tag",
      ""
    ].join("\n")
  );
}

function parseUmbrellaArgs(argv) {
  const command = argv[0];
  const rest = argv.slice(1);
  const passthrough = [];
  let cliProvider = null;
  let cliProviders = null;
  let json = false;

  for (const arg of rest) {
    if (arg.startsWith("--provider=")) {
      cliProvider = arg.slice("--provider=".length);
      continue;
    }
    if (arg.startsWith("--providers=")) {
      cliProviders = arg.slice("--providers=".length);
      continue;
    }
    if (arg === "--json") {
      json = true;
      passthrough.push(arg);
      continue;
    }
    passthrough.push(arg);
  }

  return { command, cliProvider, cliProviders, json, passthrough };
}

async function runSingle(command, parsed) {
  const { providerId, source } = resolveProvider({ cliProvider: parsed.cliProvider });
  const args = [command, ...parsed.passthrough];
  const result = await dispatchToProvider(providerId, args);

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          providerId,
          providerSource: source,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          error: result.error
        },
        null,
        2
      )}\n`
    );
  } else {
    if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    if (result.stderr && result.status !== 0) process.stderr.write(result.stderr);
  }

  process.exit(result.status === 0 ? 0 : (result.status || 1));
}

async function runCompare(parsed) {
  const { providerIds } = resolveCompareProviders({ cliProviders: parsed.cliProviders });
  // Forward "review" to each provider for compare, plus pass-through args.
  const args = ["review", ...parsed.passthrough];
  const results = await dispatchCompare(providerIds, args);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ providers: providerIds, results }, null, 2)}\n`);
  } else {
    process.stdout.write(renderCompareReport(results));
  }

  // Exit non-zero only if every provider failed; partial success is success.
  const anyOk = results.some((r) => r.status === 0);
  process.exit(anyOk ? 0 : 1);
}

async function runCodexUpdate(argv) {
  let tag = null;
  let into = null;
  let json = false;
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("--tag=")) tag = arg.slice("--tag=".length);
    else if (arg.startsWith("--into=")) into = arg.slice("--into=".length);
    else if (arg === "--json") json = true;
  }

  try {
    const result = await installCodexUpstream({
      tag: tag ?? undefined,
      into: into ?? undefined
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Installed openai/codex-plugin-cc ${result.tag} ` +
          `(version ${result.version ?? "unknown"}) into ${result.root}\n` +
          `SHA-256: ${result.sha}\n` +
          (result.replaced ? "Replaced an existing install.\n" : "")
      );
    }
    process.exit(0);
  } catch (err) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: err?.message ?? String(err) }, null, 2)}\n`
      );
    } else {
      process.stderr.write(`${err?.message ?? err}\n`);
    }
    process.exit(1);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage(process.stdout);
    process.exit(0);
  }
  const command = argv[0];
  if (!COMMANDS.has(command)) {
    usage();
    process.stderr.write(`\nUnknown command: ${command}\n`);
    process.exit(2);
  }

  if (command === "codex-update") return runCodexUpdate(argv);

  const parsed = parseUmbrellaArgs(argv);
  if (command === "compare") return runCompare(parsed);
  return runSingle(command, parsed);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
