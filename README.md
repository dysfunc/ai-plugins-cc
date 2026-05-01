# ai-plugins-cc

Claude Code plugins that delegate to external AI CLIs — Codex, Gemini, and Grok — sharing a hardened core and an optional umbrella plugin that dispatches across providers.

> **Status:** active development. The architecture is set; the `gemini`, `grok`, and `ai` umbrella plugins are usable today; the `codex-adapter` integrates with upstream `openai/codex-plugin-cc` and ships an installer + canary.

---

## What you get

- **Per-provider plugins.** `/gemini:*`, `/grok:*`, and `/codex:*` (via the upstream plugin) all behave the same way: review changes, rescue a task, run an adversarial pre-stop gate, and queue background work. You install only the providers you want.
- **An umbrella plugin.** `/ai:review`, `/ai:rescue`, `/ai:gater` route to whichever provider you've configured as your default. `/ai:compare` fans out the same review to multiple providers and returns a side-by-side report. Both umbrella and per-provider commands ship — different prefixes, no collisions.
- **A shared core.** All providers run on `@ai-plugins-cc/core`: one implementation of state management, job lifecycle, hooks, context collection, prompt assembly, rendering. A bug fix in core fixes every provider at once.
- **An adapter pattern for external plugins.** `@ai-plugins-cc/codex-adapter` integrates with upstream `openai/codex-plugin-cc` without vendoring its source. The same pattern is the cutover path when official Gemini and Grok plugins ship — we'll add `gemini-adapter` / `grok-adapter` and deprecate the in-house plugins.

---

## Installation

You need Node `>=20.0.0` and a [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) install.

### From the marketplace (recommended)

Inside Claude Code, point at this repo's marketplace and install whichever plugin you want:

```
/plugins marketplace add dysfunc/ai-plugins-cc
/plugins install gemini@ai-plugins-cc      # or grok, or ai
```

Pick `ai` if you want the umbrella with cross-provider commands; pick a single provider if you want to keep things minimal.

### From source (development)

```sh
git clone https://github.com/dysfunc/ai-plugins-cc.git
cd ai-plugins-cc
npm install
```

Then point Claude Code at this directory's `.claude-plugin/marketplace.json`.

### Codex setup

Codex is **not** listed in the marketplace — it's an OpenAI plugin we don't vendor. The umbrella's `/ai:codex-update` command installs upstream `openai/codex-plugin-cc` from GitHub into a managed cache directory. Run it once before you use `/ai:review --provider=codex`:

```
/ai:codex-update
```

This downloads the SHA-pinned upstream release, hash-verifies the tarball, and atomic-renames it into `~/.cache/ai-plugins-cc/codex-plugin-cc/`.

---

## Provider authentication

| Provider | Required env var | Fallback / SSO | Where to get a key |
|---|---|---|---|
| Gemini | `GEMINI_API_KEY` | `GOOGLE_API_KEY` · interactive `gemini auth login` (Google account) · `gcloud auth application-default login` (Vertex AI) | https://aistudio.google.com/ |
| Grok | `GROK_API_KEY` | `XAI_API_KEY` | https://console.x.ai/ |
| Codex | `OPENAI_API_KEY` | `CODEX_API_KEY` | https://platform.openai.com/ |

Each provider's `setup` command (`/gemini:setup`, `/grok:setup`, etc.) reports which credential is found and whether the underlying CLI is on `PATH`.

### Node version requirements

This monorepo's own packages need Node `>=20.0.0`. The **provider CLIs we drive** have their own minimums:

| CLI | Notes |
|---|---|
| `@google/gemini-cli` (Gemini) | Node 20+; recent versions track current LTS. Auto-installed by `/ai:setup`. |
| Grok | `@vibe-kit/grok-cli` — Node 18+, ESM, installs the `grok` binary. Auto-installed by `/ai:setup`. Avoid the older `grok-dev` package: it's Bun-targeted and fails under plain Node with `Cannot find package "node:diagnostics_channel"`. `/ai:setup` also applies an idempotent in-place patch (`scripts/patch-grok-cli.mjs`) that strips a deprecated `search_parameters` field the bundled `client.js` sends on every chat call — without it, xAI returns `410 "Live search is deprecated"` for accounts without a Live Search license. The patch must be re-applied after every `npm install -g @vibe-kit/grok-cli` upgrade; re-running `/ai:setup` does that. |
| Upstream `openai/codex-plugin-cc` (Codex) | See the upstream's `package.json` engines field. Installed for you by `/ai:codex-update`. |

---

## Usage

### Per-provider commands

Every plugin exposes the same surface, scoped to its prefix:

| Command | What it does |
|---|---|
| `/<provider>:review [--scope=diff\|repo] [--base=REF] [focus]` | Review the pending change against `main`. |
| `/<provider>:rescue <prompt>` | Hand a substantial coding task to the provider's agent. |
| `/<provider>:setup` | Probe the CLI install and current auth state. |
| `/<provider>:status [--all]` | List active and recent jobs. |
| `/<provider>:cancel [job-id]` | Cancel a running background job. |
| `/<provider>:result [job-id]` | Show a finished job's output. |
| `/<provider>:adversarial-review` | Stricter review with explicit blocking criteria. |

### Umbrella commands

```
/ai:review [--provider=gemini|grok|codex] [--scope=...] [focus]
/ai:rescue [--provider=...] <prompt>
/ai:gater  [--provider=...]
/ai:compare [--providers=A,B,C] [--action=review|rescue|gater] [--scope=...] [focus]
/ai:codex-update [--tag=vX.Y.Z]
```

`/ai:compare` fans the review out to every configured provider in parallel and returns a single markdown report with one fenced section per provider. A single provider's failure is shown in its section but doesn't abort the others. `--action=` switches the fanned-out verb (default `review`); use `--action=rescue` to ask every provider the same investigation/coding task.

### Provider precedence

Resolved in this order — first hit wins:

1. `--provider=ID` on the command line.
2. `<workspace>/.claude-plugin/ai.json` with `{ "provider": "...", "compareProviders": [...] }`.
3. `~/.claude/ai-plugins-cc.json` (same shape).
4. `AI_PLUGINS_CC_DEFAULT_PROVIDER` env var.
5. Default: `gemini`.

Workspace and user config files are JSON, e.g.:

```jsonc
{
  "provider": "grok",
  "enabledProviders": ["gemini", "grok", "codex"],
  "compareProviders": ["gemini", "grok", "codex"]
}
```

---

## First-run setup

After installing the umbrella plugin, run:

```
/ai:setup
```

It walks through:

1. **Pick providers.** Multi-select across Gemini, Grok, and Codex.
2. **Install missing CLIs.** For each pick:
   - Gemini: `npm install -g @google/gemini-cli` (only with your confirmation).
   - Grok: `npm install -g @vibe-kit/grok-cli` (Node-compatible; the older `grok-dev` package is Bun-targeted and fails under Node).
   - Codex: downloads the pinned upstream `openai/codex-plugin-cc` release into a managed cache (no vendoring).
3. **Walk through auth.** API key or SSO per provider; keys are read from env (never echoed back into chat or written to shell config without consent).
4. **Verify each.** Per-provider probe runs after every change to confirm `ready: true`.
5. **Save settings.** Writes `~/.claude/ai-plugins-cc.json` with enabled providers, default, and `/ai:compare` set.

Re-run `/ai:setup` at any time to re-verify or change selections; rerun on a fresh machine to bring the new install up to speed.

The first SessionStart on any workspace where settings haven't been written yet emits a one-line nudge: *"ai-plugins-cc: no settings yet — run /ai:setup..."*. The hook never blocks the session.

## Changing settings later

```
/ai:settings                              # interactive — show + edit
/ai:settings show                         # current state
/ai:settings enable codex                 # add codex to active providers
/ai:settings disable grok                 # remove (rolls default forward if needed)
/ai:settings set-default gemini           # change /ai:review's provider
/ai:settings set-compare gemini,codex     # ordered list for /ai:compare fan-out
```

Every mutation writes `~/.claude/ai-plugins-cc.json` atomically (temp file + rename). Disabling the current default automatically reassigns it to the first remaining enabled provider; the change is visible in the JSON output of every settings command.

---

## Architecture

```
ai-plugins-cc/
├── packages/
│   ├── core/             @ai-plugins-cc/core
│   │                     state · process · git · context · render · job-control
│   │                     tracked-jobs · workspace · fs · args · hooks · config
│   │                     The boundary every provider runs on.
│   │
│   ├── shared-prompts/   @ai-plugins-cc/shared-prompts
│   │                     Canonical prompt templates and review-output schema.
│   │
│   └── codex-adapter/    @ai-plugins-cc/codex-adapter
│                         discover · install · invoke · normalize
│                         Wraps upstream openai/codex-plugin-cc; never vendors it.
│
├── plugins/
│   ├── gemini/           @ai-plugins-cc/gemini    (in-house Claude Code plugin)
│   ├── grok/             @ai-plugins-cc/grok      (in-house Claude Code plugin)
│   └── ai/               @ai-plugins-cc/ai        (umbrella; depends on the others)
│
├── scripts/
│   ├── check-core-changeset.mjs   CI gate: core PRs require a changeset entry
│   └── codex-canary.mjs           Daily install→invoke against pinned upstream
│
└── .github/workflows/
    ├── ci.yml                     Matrix tests + changeset enforcement + release
    └── codex-canary.yml           Auto-files an issue on upstream contract drift
```

### Why this shape

- **Core is provider-agnostic by construction.** Every brand-specific string (slash command prefix, brand label, env var name, log prefix) goes through `@ai-plugins-cc/core/config`. Each plugin's entrypoint calls `setProviderIdentity({ commandPrefix, providerId, providerLabel })` once at startup. Adding a fourth provider is mechanical.
- **Providers are subprocesses, not in-process imports.** The umbrella doesn't import `gemini.mjs` or `grok.mjs`; it spawns each provider's companion script with the same argv shape. This keeps the coupling shallow and lets every provider evolve its CLI independently.
- **External providers go through an adapter.** Upstream code is never vendored. The adapter handles discovery, version pinning, hash-verified install, subprocess invocation, and output normalization. When official Gemini and Grok plugins ship, we add `gemini-adapter` / `grok-adapter` packages with the same shape and deprecate the in-house plugins behind a feature flag.
- **Bugs fixed once apply everywhere.** The five bugs surfaced by the original multi-agent review (atomic state writes, workspace path containment, child PID tracking, close-vs-exit on subprocess capture, prompt-fence escapes) all live in core. Both Gemini and Grok inherit the fixes; Codex inherits them through the adapter's invocation wrapper.

---

## Development

### Setup

```sh
git clone https://github.com/dysfunc/ai-plugins-cc.git
cd ai-plugins-cc
npm install
```

Workspaces are wired automatically. `node_modules/@ai-plugins-cc/*` symlinks each package into place.

### Tests

```sh
npm test                         # run every workspace's test suite
npm test --workspace=core        # just core
npm test --workspace=ai          # just umbrella
```

109/109 tests across five workspaces:

- `core` (35) — unit tests for state, context, render, etc.
- `codex-adapter` (24) — discovery, install, invoke, normalize
- `gemini` (17) — runtime integration via fake CLI
- `grok` (17) — same shape as gemini
- `ai` (16) — config precedence, dispatch, compare fan-out, codex-update wiring

### Running the canary locally

```sh
# pinned mode (default): installs whatever pinnedTag is in codex-adapter's package.json
npm run codex:canary

# latest mode: queries GitHub for the newest release and tries that tag
node scripts/codex-canary.mjs --mode=latest
```

Both modes hit the network. Set `GITHUB_TOKEN` to avoid rate limiting.

### Adding a new provider

1. Copy `plugins/gemini/` to `plugins/<provider>/` and rename files.
2. Replace gemini-specific strings (`Gemini` / `gemini` / `GEMINI`) with the new brand.
3. Patch the auth section of `<provider>.mjs` for your CLI's env vars and provider-specific URLs.
4. Add the provider to `plugins/ai/scripts/lib/providers.mjs`.
5. Add the provider to `.claude-plugin/marketplace.json`.
6. Run the test suite; the runtime tests should pass with no other changes (the boundary is uniform).

This is roughly what Phase 2 of the build looked like: `feat(grok): build grok plugin against hardened core`.

### Releases

Independent per-package versioning via [Changesets](https://github.com/changesets/changesets):

```sh
npm run changeset            # create a changeset entry alongside your PR
npm run changeset:version    # apply pending changesets, bump versions, update CHANGELOGs
npm run changeset:publish    # publish to npm
```

Provider plugins depend on `@ai-plugins-cc/core` via plain semver (`*`); npm's workspace resolver wires them up locally and the published packages float against caret ranges. **Any PR that touches `packages/core/**` must include a changeset entry that references `@ai-plugins-cc/core`** — `scripts/check-core-changeset.mjs` enforces this in CI.

The release workflow in `.github/workflows/ci.yml` runs Changesets' release action on `main`: it either opens a "Version Packages" PR consuming pending changesets, or publishes when that PR merges.

### Publishing to npm

Packages live under the `@ai-plugins-cc` scope and ship publicly. First-time setup:

1. Register the `@ai-plugins-cc` scope on npm (one-time, free): https://www.npmjs.com/org/create
2. Locally: `npm login` with the account that owns the org.
3. In CI: add `NPM_TOKEN` as a repo secret. The release job in `.github/workflows/ci.yml` already references it.

Each publishable `package.json` has `"publishConfig": { "access": "public" }` so the first publish doesn't fail with "402 Payment Required" (the default for scoped packages is `restricted`).

To publish manually from a clean working tree:

```sh
npm run changeset            # create entries describing what changed
npm run changeset:version    # bump versions + write CHANGELOGs
git commit -am "chore: release"
npm run changeset:publish    # publishes every package whose version was bumped
```

The five publishable packages:

- `@ai-plugins-cc/core`
- `@ai-plugins-cc/shared-prompts`
- `@ai-plugins-cc/codex-adapter`
- `@ai-plugins-cc/gemini`
- `@ai-plugins-cc/grok`
- `@ai-plugins-cc/ai`

The root `@ai-plugins-cc/monorepo` package stays `private: true` and never publishes.

---

## Project history

The build proceeded in seven phases, each landing as one or more reviewable commits:

| Phase | What |
|---|---|
| 0 | Bootstrap monorepo (workspaces, Changesets, CI scaffold, marketplace stub). |
| 1a | Verbatim lift of `gemini-plugin-cc/lib/*` into `packages/core/`, baseline tests passing. |
| 1b | Five reviewer-flagged bugs fixed in core, each as a discrete commit with a regression test. |
| 1c | `gemini.mjs` moved back to the gemini plugin; remaining gemini-isms in core de-branded behind `setProviderIdentity`. |
| 2 | Grok plugin built against the hardened core. |
| 3 | `codex-adapter`: discovery + invocation + normalization. |
| 4 | `ai` umbrella plugin: dispatch + compare + config precedence. |
| 5 | `installCodexUpstream` + `/ai:codex-update`. |
| 6 | Codex canary cron with auto-issue. |
| 7 | This README. |

The plan was developed iteratively with a multi-agent review loop — Codex and Gemini independently critiqued each draft until both verdicts converged on "ship with changes." See the commit log for the full trail.

---

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

---

## Acknowledgements

The `gemini` and `grok` plugins were originally derived from [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) (Apache 2.0). The codex-adapter integrates with that upstream at runtime; its source is not vendored.
