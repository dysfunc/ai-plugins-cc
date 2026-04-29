// Provider registry. The umbrella dispatches commands to one or more
// providers; this module is the single place that knows how to reach each.
//
// In-house providers (gemini, grok) are reached by spawning their companion
// script directly — we resolve the path via package resolution, so it works
// whether the plugin is a workspace symlink or an installed npm package.
//
// External providers (codex) are reached through @ai-plugins-cc/codex-adapter,
// which discovers and subprocess-invokes upstream openai/codex-plugin-cc.

import * as geminiMeta from "@ai-plugins-cc/gemini/meta";
import * as grokMeta from "@ai-plugins-cc/grok/meta";
import { invokeCodexCommand, discoverCodexInstall } from "@ai-plugins-cc/codex-adapter";

const PROVIDERS = {
  gemini: {
    id: geminiMeta.providerId,
    label: geminiMeta.providerLabel,
    commandPrefix: geminiMeta.commandPrefix,
    kind: "in-house",
    companionPath: geminiMeta.companionPath
  },
  grok: {
    id: grokMeta.providerId,
    label: grokMeta.providerLabel,
    commandPrefix: grokMeta.commandPrefix,
    kind: "in-house",
    companionPath: grokMeta.companionPath
  },
  codex: {
    id: "codex",
    label: "Codex",
    commandPrefix: "codex",
    kind: "external",
    invoke: invokeCodexCommand,
    probe: discoverCodexInstall
  }
};

export function listProviders() {
  return Object.keys(PROVIDERS);
}

export function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(
      `Unknown provider "${id}". Known providers: ${listProviders().join(", ")}.`
    );
  }
  return provider;
}

export function isProvider(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}
