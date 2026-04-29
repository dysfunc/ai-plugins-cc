---
description: Run a stop-time review gate via the configured AI provider
argument-hint: '[--provider=ID]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" gater $ARGUMENTS
```

The gater performs an adversarial review of the pending changes and returns either `ALLOW:` or `BLOCK:` on the first line, followed by a rationale. Provider resolution follows the same precedence as `/ai:review`.

If the gate returns `BLOCK:`, surface the rationale to the user without softening it.
