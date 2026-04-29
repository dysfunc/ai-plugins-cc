# @ai-plugins-cc/codex-adapter

Adapter that integrates with upstream `openai/codex-plugin-cc` without vendoring its source.

Responsibilities:
- **Discovery**: locate an installed copy of `codex-plugin-cc` via env override → workspace config → user config → standard Claude plugin install path → fail loudly.
- **Pinning**: install/update routine pulls a SHA-pinned tag, hash-verifies, never auto-reinstalls on invocation.
- **Invocation**: subprocess-call the upstream `codex-companion.mjs` directly using the known shared shape.
- **Normalization**: translate upstream output into the canonical schema in `@ai-plugins-cc/shared-prompts`.

Update is an explicit user-triggered action (e.g. `/ai:codex-update`), never on every dispatch.

## Status

Empty skeleton. Implemented in Phase 3.
