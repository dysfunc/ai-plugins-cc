---
description: Install or update the upstream openai/codex-plugin-cc to the pinned tag
argument-hint: '[--tag=vX.Y.Z] [--into=PATH] [--json]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" codex-update $ARGUMENTS
```

Behavior:
- Downloads `https://codeload.github.com/openai/codex-plugin-cc/tar.gz/refs/tags/<tag>`.
- Verifies the SHA-256 against `ai-plugins-cc.upstream.pinnedSha` in `@ai-plugins-cc/codex-adapter`'s `package.json` if pinned. Refuses to install on mismatch.
- Atomic-renames the extracted tree into the managed cache (default: `~/.cache/ai-plugins-cc/codex-plugin-cc/`).
- Subsequent invocations of `/ai:review --provider=codex` and friends discover this install automatically.

Override the pinned tag with `--tag=...` only when you've reviewed the upstream changes and intend to lift the pin afterwards.

Output the install summary verbatim so the user sees the resolved tag, SHA, and target path.
