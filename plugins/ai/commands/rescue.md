---
description: Hand a substantial coding task to the configured AI provider (gemini, grok, or codex)
argument-hint: '[--provider=ID] [--background] [--cwd=PATH] <prompt>'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" rescue $ARGUMENTS
```

Provider resolution follows the same precedence as `/ai:review`. If you need a specific provider, pass `--provider=<id>`.

Present the rescue agent's response to the user verbatim — do not summarize, reinterpret, or rephrase it.
