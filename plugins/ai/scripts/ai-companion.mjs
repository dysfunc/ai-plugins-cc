#!/usr/bin/env node

import process from "node:process";

import { installCodexUpstream } from "@ai-plugins-cc/codex-adapter";

import {
  dispatchToProvider,
  dispatchCompare,
  mapUmbrellaCommandToProviderArgs
} from "./lib/dispatch.mjs";
import { resolveProvider, resolveCompareProviders } from "./lib/config.mjs";
import { renderCompareReport } from "./lib/render-compare.mjs";
import { listProviders, isProvider } from "./lib/providers.mjs";
import { probeProvider, probeAllProviders } from "./lib/status.mjs";
import {
  defaultUserConfigPath,
  disableProvider,
  enableProvider,
  readSettings,
  setCompareProviders,
  setDefaultProvider
} from "./lib/settings.mjs";

const COMMANDS = new Set([
  "review",
  "rescue",
  "gater",
  "compare",
  "codex-update",
  "setup",
  "verify",
  "settings"
]);

function usage(stream = process.stderr) {
  stream.write(
    [
      "Usage: ai-companion.mjs <command> [--provider=ID] [--providers=A,B,C] [--action=review|rescue|gater] [--json] [...args]",
      "Commands:",
      "  review | rescue | gater | compare      forward to one or many providers",
      "  setup [--json]                          aggregate status across providers",
      "  verify --provider=ID [--json]           probe one provider",
      "  settings show|enable|disable|...        manage ~/.claude/ai-plugins-cc.json",
      "  codex-update [--tag=vX.Y.Z] [--pin]      install pinned upstream codex",
      "Examples:",
      "  ai-companion.mjs review --provider=gemini --scope=diff",
      "  ai-companion.mjs compare --providers=gemini,codex --scope=diff",
      "  ai-companion.mjs compare --action=rescue \"investigate the auth flow\"",
      "  ai-companion.mjs setup --json",
      "  ai-companion.mjs verify --provider=gemini --json",
      "  ai-companion.mjs settings enable codex",
      ""
    ].join("\n")
  );
}

const COMPARE_ACTIONS = new Set(["review", "rescue", "gater"]);

function parseUmbrellaArgs(argv) {
  const command = argv[0];
  const rest = argv.slice(1);
  const passthrough = [];
  let cliProvider = null;
  let cliProviders = null;
  let cliAction = null;
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
    if (arg.startsWith("--action=")) {
      cliAction = arg.slice("--action=".length);
      continue;
    }
    if (arg === "--json") {
      json = true;
      passthrough.push(arg);
      continue;
    }
    passthrough.push(arg);
  }

  return { command, cliProvider, cliProviders, cliAction, json, passthrough };
}

async function runSingle(command, parsed) {
  const { providerId, source } = resolveProvider({ cliProvider: parsed.cliProvider });
  const args = mapUmbrellaCommandToProviderArgs(command, parsed.passthrough);
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
  // Default to fanning out a review; --action=rescue|gater lets the caller
  // ask every provider to do the same investigation/gate-check instead.
  const action = parsed.cliAction ?? "review";
  if (!COMPARE_ACTIONS.has(action)) {
    process.stderr.write(
      `compare --action must be one of: ${[...COMPARE_ACTIONS].join(", ")}; got "${action}".\n`
    );
    process.exit(2);
  }
  const args = mapUmbrellaCommandToProviderArgs(action, parsed.passthrough);
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
  let pin = false;
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("--tag=")) tag = arg.slice("--tag=".length);
    else if (arg.startsWith("--into=")) into = arg.slice("--into=".length);
    else if (arg === "--json") json = true;
    else if (arg === "--pin") pin = true;
  }

  try {
    const result = await installCodexUpstream({
      tag: tag ?? undefined,
      into: into ?? undefined,
      pin
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const lines = [
        `Installed openai/codex-plugin-cc ${result.tag} ` +
          `(version ${result.version ?? "unknown"}) into ${result.root}`,
        `SHA-256: ${result.sha}`
      ];
      if (result.replaced) lines.push("Replaced an existing install.");
      if (result.pin) {
        if (result.pin.written) {
          lines.push(`Pinned SHA written to ${result.pin.packageJsonPath}`);
        } else {
          lines.push(`SHA NOT pinned: ${result.pin.reason}`);
          lines.push(`If you intended to pin, set ai-plugins-cc.upstream.pinnedSha = ${result.sha} manually.`);
        }
      }
      process.stdout.write(`${lines.join("\n")}\n`);
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

async function runSetup(argv) {
  const json = argv.includes("--json");
  const providers = await probeAllProviders();
  const settings = readSettings();
  const payload = {
    providers,
    settings,
    settingsFile: defaultUserConfigPath(),
    knownProviders: listProviders()
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const lines = ["# /ai:setup status", ""];
    for (const id of payload.knownProviders) {
      const p = providers[id];
      const enabled = settings.enabledProviders.includes(id) ? "enabled" : "disabled";
      const tag = settings.provider === id ? " [default]" : "";
      lines.push(`- ${id}${tag} (${enabled}): ${p.detail}`);
    }
    lines.push("");
    lines.push(`Settings file: ${payload.settingsFile}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  // Setup is non-fatal: a not-ready provider is information, not error.
  process.exit(0);
}

async function runVerify(argv) {
  let providerId = null;
  let json = false;
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("--provider=")) providerId = arg.slice("--provider=".length);
    else if (arg === "--json") json = true;
  }
  if (!providerId || !isProvider(providerId)) {
    const message = `verify requires --provider=<one of: ${listProviders().join(", ")}>`;
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    else process.stderr.write(`${message}\n`);
    process.exit(2);
  }

  const result = await probeProvider(providerId);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${providerId}: ${result.ready ? "ready" : "needs attention"} — ${result.detail}\n`);
  }
  process.exit(result.ready ? 0 : 1);
}

function runSettings(argv) {
  const sub = argv[1];
  const arg = argv[2];
  const rest = argv.slice(2);
  const json = rest.includes("--json");

  function emit(out) {
    if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else if (out.message) process.stdout.write(`${out.message}\n`);
    else process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  }

  try {
    if (!sub || sub === "show") {
      const settings = readSettings();
      emit({ ok: true, settings, settingsFile: defaultUserConfigPath() });
      process.exit(0);
    }
    if (sub === "enable") {
      const { settings, filePath } = enableProvider(arg);
      emit({
        ok: true,
        action: "enable",
        provider: arg,
        settings,
        settingsFile: filePath,
        message: `Enabled ${arg}. Active providers: ${settings.enabledProviders.join(", ") || "(none)"}`
      });
      process.exit(0);
    }
    if (sub === "disable") {
      const { settings, filePath } = disableProvider(arg);
      emit({
        ok: true,
        action: "disable",
        provider: arg,
        settings,
        settingsFile: filePath,
        message: `Disabled ${arg}. Active providers: ${settings.enabledProviders.join(", ") || "(none)"}`
      });
      process.exit(0);
    }
    if (sub === "set-default") {
      const { settings, filePath } = setDefaultProvider(arg);
      emit({
        ok: true,
        action: "set-default",
        provider: arg,
        settings,
        settingsFile: filePath,
        message: `Default provider is now ${arg}.`
      });
      process.exit(0);
    }
    if (sub === "set-compare") {
      const ids = (arg ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const { settings, filePath } = setCompareProviders(ids);
      emit({
        ok: true,
        action: "set-compare",
        providers: ids,
        settings,
        settingsFile: filePath,
        message: `/ai:compare will fan out to: ${ids.join(", ") || "(default — all registered providers)"}`
      });
      process.exit(0);
    }
    process.stderr.write(`settings: unknown subcommand "${sub}"\n`);
    process.stderr.write(
      "  show | enable <id> | disable <id> | set-default <id> | set-compare <id,id,...>\n"
    );
    process.exit(2);
  } catch (err) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err?.message ?? String(err) }, null, 2)}\n`);
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
  if (command === "setup") return runSetup(argv);
  if (command === "verify") return runVerify(argv);
  if (command === "settings") return runSettings(argv);

  const parsed = parseUmbrellaArgs(argv);
  if (command === "compare") return runCompare(parsed);
  return runSingle(command, parsed);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
