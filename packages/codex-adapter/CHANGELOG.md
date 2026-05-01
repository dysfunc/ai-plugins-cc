# @ai-plugins-cc/codex-adapter

## 0.2.0

### Minor Changes

- Convergence + security audit fixes since `0.1.0`.

  `@ai-plugins-cc/ai`:

  - `/plugin install ai@ai-plugins-cc` is now self-sufficient. The umbrella ships bundled gemini/grok runtimes at `sibling-fallback/<provider>/`; `resolveSiblingCompanionPath` falls back to them when the per-provider Claude plugin isn't installed. Real sibling installs still win when present, so `/gemini:*` users keep their installed-plugin code. Per-provider plugins are now optional — only needed for the dedicated `/gemini:*` / `/grok:*` slash commands.
  - New `grok-patch` umbrella subcommand. Locates and runs the grok plugin's `patch-grok-cli.mjs` (now living in `plugins/grok/scripts/` instead of the umbrella's directory).
  - `mapUmbrellaCommandToProviderArgs` no longer mistakes the value half of `--scope diff` / `--base main` / `-m flash` for focus text — explicit value-option awareness, with `--` passthrough sentinel handled too.
  - `/ai:compare` falls through `compareProviders` → `enabledProviders` → all-registered, so an empty compare list no longer fans out to providers the user never enabled.
  - Live stderr streaming on non-JSON `/ai:compare` runs, prefixed with `[<provider>] `. Each provider's progress shows up while codex's adversarial review is still running, instead of a 5–10 minute blank screen.
  - In-house companion dispatch now runs through a small env allowlist (mirrors the codex-adapter pattern) — provider CLIs no longer inherit every secret in the parent shell.
  - `spawnInHouseCompanion` caps stdout (50 MB) and stderr (10 MB), and timeout / cap-overrun kills the whole process group via `process.kill(-pid)` so companion-spawned grandchildren don't leak.
  - `resolveSiblingCompanionPath` validates `providerId` against an allowlist and bounds resolved candidates to known-safe ancestor directories (workspace dev, marketplace cache, or the umbrella's own bundled fallback root). The duplicate `marketplaceFlat` candidate is gone. `SiblingPluginMissingError` differentiates "missing sibling plugin" from "missing CLI" so the wizard can surface the right remediation.
  - Settings mutations now run inside an advisory `withLock` (open-O_EXCL `<file>.lock`, stale-PID detection) so concurrent `/ai:settings` invocations can't silently overwrite each other.

  `@ai-plugins-cc/core`:

  - New `scrubSecrets(text)` export, applied automatically inside `appendLogLine` and `appendLogBlock`. Workspace log files no longer capture xAI / OpenAI / Anthropic / Google API keys or `Bearer` tokens — provider CLIs occasionally print them in 401/403 errors, and those logs persist on disk indefinitely.

  `@ai-plugins-cc/codex-adapter`:

  - `installCodexUpstream` now refuses to install when `pinnedSha` is null unless the caller passes `allowUnpinned: true` or sets `AI_PLUGINS_CC_ALLOW_UNPINNED_CODEX=1`. Closes a supply-chain hole where a compromised release feed could land arbitrary JS that then got `spawn`-execed. The current pinned SHA-256 for `openai/codex-plugin-cc@v1.0.4` is `2cbcbcb01e937f2a11e1e9b05b4e2a31529417d0eae00b80b7febb2381e4e88c`.
  - `invokeCodexCommand` accepts an `onStderr(chunk)` callback so the umbrella's compare can stream codex progress live.

  `@ai-plugins-cc/grok`:

  - New `plugins/grok/scripts/patch-grok-cli.mjs`. Resolves the actual `grok` binary via `GROK_BIN` → `which grok` → `npm root -g` (in priority); rejects symlinks in the binary lookup; caps walk-up to 3 directories; verifies the resolved `client.js` lives inside an `@vibe-kit/grok-cli` install before writing. Fails closed when the expected `search_parameters` pattern isn't present, so an upstream-fixed CLI surfaces explicitly rather than being silently no-op'd.

  `@ai-plugins-cc/gemini`, `@ai-plugins-cc/shared-prompts`: pulled along through workspace dependencies; no direct source changes.

### Patch Changes

- Updated dependencies
  - @ai-plugins-cc/core@0.2.0
  - @ai-plugins-cc/shared-prompts@0.1.1

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
