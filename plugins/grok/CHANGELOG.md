# @ai-plugins-cc/grok

## 0.1.0

### Minor Changes

- Initial published release at `0.1.0`.

  `@ai-plugins-cc/ai` notable changes since pre-release work:

  - Translate umbrella verbs (`review` + focus → `adversarial-review`, `rescue` → `task`, `gater` → `adversarial-review`) so per-provider companions stop crashing with `Unknown subcommand`. `/ai:compare` gains `--action=review|rescue|gater` (default `review`) so a focused fan-out can target any of the provider verbs.
  - Empty `compareProviders: []` in user/workspace config now falls through to the default-all set instead of being treated as an explicit empty list.
  - `GEMINI_CLI_TRUST_WORKSPACE=true` is set by default in gemini's dispatch env so non-interactive subprocesses don't trip the trusted-folder error.
  - New `scripts/patch-grok-cli.mjs` strips a deprecated `search_parameters` assignment from `@vibe-kit/grok-cli`'s bundled `client.js`. Without it, xAI returns `410 "Live search is deprecated"` for accounts without a Live Search license. `/ai:setup` applies it on every run; idempotent.
  - `/ai:setup` recommends `~/.zshenv` for persisted API keys (sourced by non-interactive zsh) instead of `~/.zshrc` (interactive only).

  Other packages (`core`, `codex-adapter`, `shared-prompts`, `gemini`, `grok`) bump to `0.1.0` as part of the coordinated initial public release.

- Translate umbrella verbs to per-provider companion subcommands so /ai:rescue and /ai:gater stop crashing with "Unknown subcommand" and /ai:compare with focus text stops 410'ing on codex. Mapping: review+focus → adversarial-review, rescue →

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @ai-plugins-cc/core@0.1.0
  - @ai-plugins-cc/shared-prompts@0.1.0
