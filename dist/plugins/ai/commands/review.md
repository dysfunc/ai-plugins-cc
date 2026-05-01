---
description: Review the pending change with the configured AI provider (gemini, grok, or codex)
argument-hint: '[--provider=ID] [--scope=diff|repo] [--base=REF] [focus text]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" review $ARGUMENTS
```

Provider precedence (high → low):
1. `--provider=ID` on the command line
2. `<workspace>/.claude-plugin/ai.json` with `{ "provider": "ID" }`
3. `~/.claude/ai-plugins-cc.json` with `{ "provider": "ID" }`
4. `AI_PLUGINS_CC_DEFAULT_PROVIDER` env var
5. Default: `gemini`

Output the result returned by the underlying provider verbatim; do not summarize or rephrase its findings.
