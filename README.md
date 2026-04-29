# ai-plugins-cc

Monorepo for Claude Code plugins that delegate to external AI CLIs (Codex, Gemini, Grok), with a shared core library and an optional umbrella plugin.

## Layout

```
packages/
  core/             @ai-plugins-cc/core            shared lib used by gemini + grok
  shared-prompts/   @ai-plugins-cc/shared-prompts  canonical prompts + review schema
  codex-adapter/    @ai-plugins-cc/codex-adapter   wraps upstream openai/codex-plugin-cc

plugins/
  gemini/           @ai-plugins-cc/gemini          maintained here until official ships
  grok/             @ai-plugins-cc/grok            maintained here until official ships
  ai/               @ai-plugins-cc/ai              umbrella: /ai:review|rescue|gater|compare
```

The marketplace lists three plugins: `gemini`, `grok`, and `ai`. Codex is not listed; the umbrella plugin handles installation of the upstream `openai/codex-plugin-cc` and integrates with it via the codex-adapter.

## Development

Requires Node `>=20.0.0`.

```sh
npm install
npm test
```

Each plugin and package ships its own tests via `npm test --workspaces`.

## Versioning and releases

Independent per-package versioning via [Changesets](https://github.com/changesets/changesets). Provider plugins depend on `@ai-plugins-cc/core` via `workspace:^`. Any PR that touches `packages/core` requires a changeset entry; CI enforces this.

```sh
npm run changeset            # create a changeset for your PR
npm run changeset:version    # bump versions (release branch)
npm run changeset:publish    # publish to npm
```

## Origin

The `gemini` and `grok` plugins were originally derived from `openai/codex-plugin-cc`. This repo unifies them, extracts the shared core, and adds an adapter pattern that lets us track upstream Codex without vendoring its source.
