---
description: Fan out a review to multiple AI providers and render their findings side-by-side
argument-hint: '[--providers=A,B,C] [--scope=diff|repo] [--base=REF] [focus text]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" compare $ARGUMENTS
```

Provider list precedence (high → low):
1. `--providers=A,B,C` on the command line
2. `<workspace>/.claude-plugin/ai.json` with `{ "compareProviders": [...] }`
3. `~/.claude/ai-plugins-cc.json` with `{ "compareProviders": [...] }`
4. Default: every registered provider (gemini, grok, codex)

Each provider runs independently in parallel. A single provider's failure does not abort the others.

Present the side-by-side report verbatim — preserve every provider's section, including the failed ones.
