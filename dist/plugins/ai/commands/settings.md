---
description: Show or change which AI providers are enabled, the default, and the /ai:compare set
argument-hint: '[show|enable <id>|disable <id>|set-default <id>|set-compare <id,id,...>]'
allowed-tools: Bash(node:*), AskUserQuestion
---

If the user passed a subcommand in `$ARGUMENTS`, run it directly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" settings $ARGUMENTS --json
```

Surface the JSON's `message` field to the user. If the call exits non-zero, show `error`.

If `$ARGUMENTS` is empty, drive the interactive flow:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" settings show --json` to read current state.
2. Show a short status block: enabled providers, default, compare set.
3. Use `AskUserQuestion` (single choice) to ask what they want to do:
   - "Enable a provider"
   - "Disable a provider"
   - "Change default provider"
   - "Change `/ai:compare` set"
   - "Done"
4. Based on the choice, ask for the provider id(s) (use `AskUserQuestion` again with the registered providers as options), then run the matching subcommand:
   - `settings enable <id>` / `disable <id>` / `set-default <id>` / `set-compare <id,id,...>`
5. Loop back to step 1 until the user picks "Done".

## Hard rules

- Never enable a provider that's not in `knownProviders` from `settings show --json`. The companion will reject it; surface its error verbatim if the user insisted.
- Disabling the current default reassigns the default to the first remaining enabled provider (this is automatic in the companion). Tell the user this happened.
- If the user wants to enable a provider that isn't yet ready (CLI missing, no auth), suggest running `/ai:setup` instead of trying to enable it here.
