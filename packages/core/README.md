# @ai-plugins-cc/core

Shared core library for ai-plugins-cc.

Owns: job lifecycle, state, hooks, rendering, context collection, prompt assembly, dispatch, and the Provider contract.

Consumers: `@ai-plugins-cc/gemini`, `@ai-plugins-cc/grok`, `@ai-plugins-cc/codex-adapter`, `@ai-plugins-cc/ai`.

## Provider contract

```
Provider {
  id, cli{detect, version, authStatus, spawn, cancel},
  transcript{append, read}, telemetry{emit},
  trustEnv,
  capabilities: { reviewer?, rescuer?, gater? }
}
```

Each capability owns: prompt selection, parser/schema, timeout policy, supported command surface.

## Status

Empty skeleton. Source is extracted from `gemini-plugin-cc/plugins/gemini/scripts/lib/*.mjs` in Phase 1a (verbatim) and hardened in Phase 1b.
