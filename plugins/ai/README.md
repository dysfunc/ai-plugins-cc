# @ai-plugins-cc/ai

Umbrella Claude Code plugin. Provides cross-provider commands:

- `/ai:review` — dispatches a review to one provider (configurable).
- `/ai:rescue` — dispatches a rescue task.
- `/ai:gater` — runs a stop-gate review.
- `/ai:compare` — fans out to multiple providers and renders side-by-side.

Per-provider commands (`/codex:*`, `/gemini:*`, `/grok:*`) remain available from their respective plugins. Both namespaces ship — different prefixes, no collisions.

Config precedence: CLI flag > workspace config > user config > default.

## Codex integration

Calls upstream `openai/codex-plugin-cc` via `@ai-plugins-cc/codex-adapter`. The adapter handles discovery, version pinning, subprocess invocation, and output normalization. Codex is not listed in the marketplace; the umbrella's setup command installs and updates the upstream plugin explicitly.

## Status

Skeleton. Built in Phase 4.
