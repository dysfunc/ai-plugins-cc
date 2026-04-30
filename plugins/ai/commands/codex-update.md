---
description: Install or update the upstream openai/codex-plugin-cc to the pinned tag
argument-hint: '[--tag=vX.Y.Z] [--into=PATH] [--pin] [--json]'
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

Flags:
- `--tag=vX.Y.Z` — override the pinned tag. Use only when you've reviewed the upstream changes and intend to lift the pin afterwards.
- `--pin` — after install, write the observed SHA back into `@ai-plugins-cc/codex-adapter`'s `package.json` so subsequent installs hash-verify against it. **Maintainer flag only**: refuses to write to a `node_modules` copy and surfaces the SHA so it can be pasted manually instead.
- `--into=PATH` — override the install directory.
- `--json` — emit the full result as JSON.

Output the install summary verbatim so the user sees the resolved tag, SHA, target path, and whether the pin was written.
